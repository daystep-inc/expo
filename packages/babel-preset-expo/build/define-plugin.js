"use strict";
/**
 * Copyright © 2024 650 Industries.
 * Copyright (c) 2016 Formidable
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Checks if the given identifier is an ES module import
 * @param  {babelNode} identifierNodePath The node to check
 * @return {boolean} Indicates if the provided node is an import specifier or references one
 */
const isImportIdentifier = (identifierNodePath) => {
    if (identifierNodePath.container &&
        !Array.isArray(identifierNodePath.container) &&
        'type' in identifierNodePath.container) {
        return (identifierNodePath.container.type === 'ImportDefaultSpecifier' ||
            identifierNodePath.container.type === 'ImportSpecifier');
    }
    return false;
};
const memberExpressionComparator = (nodePath, value) => nodePath.matchesPattern(value);
const identifierComparator = (nodePath, value) => 'name' in nodePath.node && nodePath.node.name === value;
const unaryExpressionComparator = (nodePath, value) => {
    if ('argument' in nodePath.node && nodePath.node.argument && 'name' in nodePath.node?.argument) {
        return nodePath.node.argument.name === value;
    }
    return false;
};
const TYPEOF_PREFIX = 'typeof ';
function definePlugin({ types: t }) {
    /**
     * Replace a node with a given value. If the replacement results in a BinaryExpression, it will be
     * evaluated. For example, if the result of the replacement is `var x = "production" === "production"`
     * The evaluation will make a second replacement resulting in `var x = true`
     */
    function replaceAndEvaluateNode(nodePath, replacement) {
        nodePath.replaceWith(t.valueToNode(replacement));
        if (nodePath.parentPath && nodePath.parentPath.isBinaryExpression()) {
            const result = nodePath.parentPath.evaluate();
            if (result.confident) {
                nodePath.parentPath.replaceWith(t.valueToNode(result.value));
            }
        }
    }
    const isLeftHandSideOfAssignmentExpression = (node, parent) => t.isAssignmentExpression(parent) && parent.left === node;
    const processNode = (replacements, nodePath, comparator) => {
        const replacementKey = Object.keys(replacements).find((value) => comparator(nodePath, value));
        if (typeof replacementKey === 'string' &&
            replacements != null &&
            replacementKey in replacements) {
            replaceAndEvaluateNode(nodePath, replacements[replacementKey]);
        }
    };
    return {
        name: 'expo-define-globals',
        visitor: {
            // process.env.NODE_ENV;
            MemberExpression(nodePath, state) {
                if (
                // Prevent rewriting if the member expression is on the left-hand side of an assignment
                isLeftHandSideOfAssignmentExpression(nodePath.node, nodePath.parent)) {
                    return;
                }
                const replacements = state.opts;
                assertOptions(replacements);
                processNode(replacements, nodePath, memberExpressionComparator);
            },
            // const x = { version: VERSION };
            ReferencedIdentifier(nodePath, state) {
                const binding = nodePath.scope?.getBinding(nodePath.node.name);
                if (binding ||
                    // Don't transform import identifiers. This is meant to mimic webpack's
                    // DefinePlugin behavior.
                    isImportIdentifier(nodePath) ||
                    // Do not transform Object keys / properties unless they are computed like {[key]: value}
                    (nodePath.key === 'key' &&
                        nodePath.parent &&
                        'computed' in nodePath.parent &&
                        nodePath.parent.computed === false) ||
                    (nodePath.key === 'property' &&
                        nodePath.parent &&
                        'computed' in nodePath.parent &&
                        nodePath.parent.computed === false)) {
                    return;
                }
                const replacements = state.opts;
                assertOptions(replacements);
                processNode(replacements, nodePath, identifierComparator);
            },
            // typeof window
            UnaryExpression(nodePath, state) {
                if (nodePath.node.operator !== 'typeof') {
                    return;
                }
                const replacements = state.opts;
                assertOptions(replacements);
                const typeofValues = {};
                Object.keys(replacements).forEach((key) => {
                    if (key.substring(0, TYPEOF_PREFIX.length) === TYPEOF_PREFIX) {
                        typeofValues[key.substring(TYPEOF_PREFIX.length)] = replacements[key];
                    }
                });
                processNode(typeofValues, nodePath, unaryExpressionComparator);
            },
        },
    };
}
function assertOptions(opts) {
    if (opts == null || typeof opts !== 'object') {
        throw new Error('define plugin expects an object as options');
    }
}
exports.default = definePlugin;
