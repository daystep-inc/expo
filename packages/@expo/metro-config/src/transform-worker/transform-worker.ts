/**
 * Copyright 2023-present 650 Industries (Expo). All rights reserved.
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { TransformResultDependency } from '@expo/metro/metro/DeltaBundler';
import countLines from '@expo/metro/metro/lib/countLines';
import type {
  JsTransformerConfig,
  JsTransformOptions,
  JsOutput,
} from '@expo/metro/metro-transform-worker';
import { relative, dirname } from 'node:path';

import { getBrowserslistTargets } from './browserslist';
import { wrapDevelopmentCSS } from './css';
import {
  collectCssImports,
  matchCssModule,
  printCssWarnings,
  transformCssModuleWeb,
} from './css-modules';
import { parseEnvFile } from './dot-env-development';
import * as worker from './metro-transform-worker';
import { transformPostCssModule } from './postcss';
import { compileSass, matchSass } from './sass';
import { ExpoJsOutput } from '../serializer/jsOutput';
import { toPosixPath } from '../utils/filePath';

interface TransformResponse {
  readonly dependencies: readonly TransformResultDependency[];
  readonly output: readonly JsOutput[];
}

const debug = require('debug')('expo:metro-config:transform-worker') as typeof console.log;

function getStringArray(value: any): string[] | undefined {
  if (!value) return undefined;
  if (typeof value === 'string') {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    throw new Error('Expected an array of strings for the `clientBoundaries` option.');
  }
  if (Array.isArray(value)) {
    return value;
  }
  throw new Error('Expected an array of strings for the `clientBoundaries` option.');
}

export async function transform(
  config: JsTransformerConfig,
  projectRoot: string,
  filename: string,
  data: Buffer,
  options: JsTransformOptions
): Promise<TransformResponse> {
  const posixFilename = toPosixPath(filename);
  if (
    typeof options.customTransformOptions?.dom === 'string' &&
    posixFilename.match(/expo\/dom\/entry\.js/)
  ) {
    // TODO: Find some method to do this without invalidating the cache between different DOM components.
    // Inject source for DOM component entry.
    const relativeDomComponentEntry = JSON.stringify(decodeURI(options.customTransformOptions.dom));
    const src = `require('expo/dom/internal').registerDOMComponent(require(${relativeDomComponentEntry}).default);`;
    return worker.transform(config, projectRoot, filename, Buffer.from(src), options);
  }
  if (posixFilename.match(/(^|\/)expo\/virtual\/rsc\.js/)) {
    const environment = options.customTransformOptions?.environment;
    const isServer = environment === 'node' || environment === 'react-server';

    if (!isServer) {
      const clientBoundaries = getStringArray(options.customTransformOptions?.clientBoundaries);
      // Inject client boundaries into the root client bundle for production bundling.
      if (clientBoundaries) {
        debug('Parsed client boundaries:', clientBoundaries);

        // Inject source
        const src =
          'module.exports = {\n' +
          clientBoundaries
            .map((boundary: string) => {
              const serializedBoundary = JSON.stringify(boundary);
              return `[\`$\{require.resolveWeak(${serializedBoundary})}\`]: /* ${boundary} */ () => import(${serializedBoundary}),`;
            })
            .join('\n') +
          '\n};';

        return worker.transform(
          config,
          projectRoot,
          filename,
          Buffer.from('/* RSC client boundaries */\n' + src),
          options
        );
      }
    }
  }

  if (options.type !== 'asset' && /\.(s?css|sass)$/.test(filename)) {
    return transformCss(config, projectRoot, filename, data, options);
  }

  // If the file is not CSS, then use the default behavior.
  const environment = options.customTransformOptions?.environment;
  const isClientEnvironment = environment !== 'node' && environment !== 'react-server';
  if (
    isClientEnvironment &&
    // TODO: Ensure this works with windows.
    (filename.match(new RegExp(`^app/\\+html(\\.${options.platform})?\\.([tj]sx?|[cm]js)?$`)) ||
      // Strip +api files.
      filename.match(/\+api(\.(native|ios|android|web))?\.[tj]sx?$/))
  ) {
    // Remove the server-only +html file and API Routes from the bundle when bundling for a client environment.
    return worker.transform(
      config,
      projectRoot,
      filename,
      !options.minify
        ? Buffer.from(
            // Use a string so this notice is visible in the bundle if the user is
            // looking for it.
            '"> The server-only file was removed from the client JS bundle by Expo CLI."'
          )
        : Buffer.from(''),
      options
    );
  }

  if (
    isClientEnvironment &&
    !filename.match(/\/node_modules\//) &&
    filename.match(/\+api(\.(native|ios|android|web))?\.[tj]sx?$/)
  ) {
    // Clear the contents of +api files when bundling for the client.
    // This ensures that the client doesn't accidentally use the server-only +api files.
    return worker.transform(config, projectRoot, filename, Buffer.from(''), options);
  }

  // Add support for parsing env files to JavaScript objects. Stripping the non-public variables in client environments.
  if (filename.match(/(^|\/)\.env(\.(local|(development|production)(\.local)?))?$/)) {
    const envFileParsed = parseEnvFile(data.toString('utf-8'), isClientEnvironment);
    return worker.transform(
      config,
      projectRoot,
      filename,
      Buffer.from(`export default ${JSON.stringify(envFileParsed)};`),
      options
    );
  }

  if (
    // Noop the streams polyfill in the server environment.
    !isClientEnvironment &&
    filename.match(/\/expo\/virtual\/streams\.js$/)
  ) {
    return worker.transform(config, projectRoot, filename, Buffer.from(''), options);
  }
  if (
    // Parsing the virtual env is client-only, on the server we use `process.env` directly.
    isClientEnvironment &&
    // Finally match the virtual env file.
    filename.match(/\/expo\/virtual\/env\.js$/)
  ) {
    if (
      // Variables should be inlined in production. We only use this JS object to ensure HMR in development.
      options.dev
    ) {
      const relativePath = relative(dirname(filename), projectRoot);
      const posixPath = toPosixPath(relativePath);

      // This virtual module uses a context module to conditionally observe and load all of the possible .env files in development.
      // We then merge them in the expected order.
      // This module still depends on the `process.env` polyfill in the serializer to include EXPO_PUBLIC_ variables that are
      // defined in the script or bash, essentially all places where HMR is not possible.
      // Finally, we export with `env` to align with the babel plugin that transforms static process.env usage to the virtual module.
      // The .env regex depends `watcher.additionalExts` being set correctly (`'env', 'local', 'development'`) so that .env files aren't resolved as platform extensions.
      const contents = `const dotEnvModules = require.context(${JSON.stringify(posixPath)},false,/^\\.\\/\\.env/);
    
    export const env = !dotEnvModules.keys().length ? process.env : { ...process.env, ...['.env', '.env.development', '.env.local', '.env.development.local'].reduce((acc, file) => {
      return { ...acc, ...(dotEnvModules(file)?.default ?? {}) };
    }, {}) };`;
      return worker.transform(config, projectRoot, filename, Buffer.from(contents), options);
    } else {
      // Add a fallback in production for sanity and better errors if something goes wrong or the user manually imports the virtual module somehow.

      // Create a proxy module where a helpful error is thrown whenever a key from `process.env` is accessed.
      const contents = `
        export const env = new Proxy({}, {
          get(target, key) {
            throw new Error(\`Attempting to access internal environment variable "\${key}" is not supported in production bundles. Environment variables should be inlined in production by Babel.\`);
          },
       });`;
      return worker.transform(config, projectRoot, filename, Buffer.from(contents), options);
    }
  }

  return worker.transform(config, projectRoot, filename, data, options);
}

function isReactServerEnvironment(options: JsTransformOptions): boolean {
  return options.customTransformOptions?.environment === 'react-server';
}

async function transformCss(
  config: JsTransformerConfig,
  projectRoot: string,
  filename: string,
  data: Buffer,
  options: JsTransformOptions
): Promise<TransformResponse> {
  // If the platform is not web, then return an empty module.
  if (options.platform !== 'web') {
    const code = matchCssModule(filename) ? 'module.exports={ unstable_styles: {} };' : '';
    return worker.transform(
      config,
      projectRoot,
      filename,
      // TODO: Native CSS Modules
      Buffer.from(code),
      options
    );
  }

  let code = data.toString('utf8');

  // Apply postcss transforms
  const postcssResults = await transformPostCssModule(projectRoot, {
    src: code,
    filename,
  });

  if (postcssResults.hasPostcss) {
    code = postcssResults.src;
  }

  // TODO: When native has CSS support, this will need to move higher up.
  const syntax = matchSass(filename);
  if (syntax) {
    code = compileSass(projectRoot, { filename, src: code }, { syntax }).src;
  }

  // If the file is a CSS Module, then transform it to a JS module
  // in development and a static CSS file in production.
  if (matchCssModule(filename)) {
    const results = await transformCssModuleWeb({
      // NOTE(cedric): use POSIX-formatted filename fo rconsistent CSS module class names.
      // This affects the content hashes, which should be stable across platforms.
      filename: toPosixPath(filename),
      src: code,
      options: {
        reactServer: isReactServerEnvironment(options),
        projectRoot,
        dev: options.dev,
        minify: options.minify,
        sourceMap: false,
      },
    });

    const jsModuleResults = await worker.transform(
      config,
      projectRoot,
      filename,
      Buffer.from(results.output),
      options
    );

    const cssCode = results.css.toString();
    const output: ExpoJsOutput[] = [
      {
        type: 'js/module',
        data: {
          ...jsModuleResults.output[0]?.data,

          // Append additional css metadata for static extraction.
          css: {
            code: cssCode,
            lineCount: countLines(cssCode),
            map: [],
            functionMap: null,
            // Disable caching for CSS files when postcss is enabled and has been run on the file.
            // This ensures that things like tailwind can update on every change.
            skipCache: postcssResults.hasPostcss,
            externalImports: results.externalImports,
          },
        },
      },
    ];

    return {
      dependencies: jsModuleResults.dependencies.concat(results.dependencies),
      output,
    };
  }

  // Global CSS:

  const { transform } = require('lightningcss') as typeof import('lightningcss');

  // Here we delegate bundling to lightningcss to resolve all CSS imports together.
  // TODO: Add full CSS bundling support to Metro.
  const cssResults = transform({
    filename,
    code: Buffer.from(code),
    errorRecovery: true,
    sourceMap: false,
    cssModules: false,
    projectRoot,
    minify: options.minify,
    analyzeDependencies: true,
    targets: await getBrowserslistTargets(projectRoot),
    // targets: pkg?.browserslist,
    // @ts-expect-error: Added for testing against virtual file system.
    resolver: options._test_resolveCss,
    // https://lightningcss.dev/transpilation.html
    include: 1, // Nesting
  });

  printCssWarnings(filename, code, cssResults.warnings);

  const cssImports = collectCssImports(filename, code, cssResults.code.toString(), cssResults);
  const cssCode = cssImports.code;

  // Append additional css metadata for static extraction.
  const cssOutput: Required<ExpoJsOutput['data']['css']> = {
    code: cssCode,
    lineCount: countLines(cssCode),
    map: [],
    functionMap: null,
    // Disable caching for CSS files when postcss is enabled and has been run on the file.
    // This ensures that things like tailwind can update on every change.
    skipCache: postcssResults.hasPostcss,
    externalImports: cssImports.externalImports,
  };

  const reactServer = isReactServerEnvironment(options);

  // Create a mock JS module that exports an empty object,
  // this ensures Metro dependency graph is correct.
  const jsModuleResults = await worker.transform(
    config,
    projectRoot,
    filename,
    options.dev
      ? Buffer.from(wrapDevelopmentCSS({ src: cssCode, filename, reactServer }))
      : Buffer.from(''),
    options
  );

  // In production, we export the CSS as a string and use a special type to prevent
  // it from being included in the JS bundle. We'll extract the CSS like an asset later
  // and append it to the HTML bundle.
  const output: ExpoJsOutput[] = [
    {
      type: 'js/module',
      data: {
        ...(jsModuleResults.output[0] as ExpoJsOutput).data,
        css: cssOutput,
      },
    },
  ];

  return {
    dependencies: jsModuleResults.dependencies.concat(cssImports.dependencies),
    output,
  };
}

/**
 * A custom Metro transformer that adds support for processing Expo-specific bundler features.
 * - Global CSS files on web.
 * - CSS Modules on web.
 * - TODO: Tailwind CSS on web.
 */
module.exports = {
  // Use defaults for everything that's not custom.
  ...worker,
  transform,
};
