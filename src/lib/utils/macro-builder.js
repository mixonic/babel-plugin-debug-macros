import { satisfies } from 'semver';

const DEBUG = 'DEBUG';

export default class MacroBuilder {
  constructor(t, options) {
    this.t = t;
    this.expressions = [];
    this.localBindings = [];
    this.importedBindings = [];
    this.flagDeclarations = [];
    this.importedDebugTools = false;
    this.packageVersion = options.packageVersion;
    this.envFlags = options.envFlags.flags;
    this.featureFlags = options.features;
    this.externalizeHelpers = !!options.externalizeHelpers;
    this.helpers = options.externalizeHelpers;
  }

  /**
   * Injects the either the env-flags module with the debug binding or
   * adds the debug binding if missing from the env-flags module.
   */
  injectFlags(path) {
    let debugBinding = path.scope.getBinding(DEBUG);
    let { t } = this;
    let name;

    let importsToClean;

    if (!this._hasDebugModule(debugBinding)) {
      name = path.scope.generateUidIdentifier(DEBUG);

      if (this.expressions.length > 0) {
        this._injectDebug(path, name);
      }

      this._expand(name.name);
    } else {
      name = DEBUG;
      this._expand(DEBUG);
      this.inlineEnvFlags(debugBinding.path.parentPath);
    }

    this._cleanImports(path);
  }

  _injectDebug(path, name) {
    let { t } = this;
    path.node.body.unshift(t.variableDeclaration('const', [t.variableDeclarator(name, t.numericLiteral(this.envFlags.DEBUG))]));
  }

  inlineEnvFlags(path) {
    let flagDeclarations = this.generateFlagConstants(path.node.specifiers, this.envFlags, path.node.source.value);
    path.replaceWithMultiple(flagDeclarations);
  }

  inlineFeatureFlags(path) {
    for (let i = 0; i < this.featureFlags.length; i++) {
      let features = this.featureFlags[i];
      if (features.featuresImport === path.node.source.value) {
        let flagDeclarations = this.generateFlagConstants(path.node.specifiers, features.flags, path.node.source.value);
        path.replaceWithMultiple(flagDeclarations);
        break;
      }
    }
  }

  generateFlagConstants(specifiers, flagTable, source) {
    let { t } = this;
    return specifiers.map((specifier) => {
      let flag = flagTable[specifier.imported.name];
      if (flag !== undefined) {
        return t.variableDeclaration('const', [t.variableDeclarator(t.identifier(specifier.imported.name), t.numericLiteral(flag))]);
      }

      throw new Error(`Imported ${specifier.imported.name} from ${source} which is not a supported flag.`);
    });
  }

  /**
   * Collects the import bindings for the debug tools.
   */
  collectSpecifiers(specifiers) {
    this.importedDebugTools = true;
    specifiers.forEach((specifier) => {
      this.importedBindings.push(specifier.imported.name);
      this.localBindings.push(specifier.local.name);
    });
  }

  /**
   * Builds the expressions that the CallExpression will expand into.
   */
  buildExpression(path) {
    let expression = path.node.expression;
    let { t, localBindings, importedBindings } = this;
    if (t.isCallExpression(expression) && localBindings.indexOf(expression.callee.name) > -1) {
      let imported = importedBindings[localBindings.indexOf(expression.callee.name)];
      this[`_${imported}`](path, t);
    }
  }

  _hasDebugModule(debugBinding) {
    let fromModule = debugBinding && debugBinding.kind === 'module';
    let moduleName = fromModule && debugBinding.path.parent.source.value;
    return moduleName === '@ember/env-flags';
  }

  _expand(binding) {
    for (let i = 0; i < this.expressions.length; i++) {
      let [exp, logicalExp] = this.expressions[i];
      exp.replaceWith(this.t.parenthesizedExpression(logicalExp(binding)));
    }
  }

  _cleanImports(path) {
    let { externalizeHelpers, helpers } = this;

    if (this.localBindings.length > 0) {
      let importDeclaration = path.scope.getBinding(this.localBindings[0]).path.parentPath;

      if (externalizeHelpers && helpers.module) {
        if (typeof helpers.module === 'string') {
          importDeclaration.node.source.value = helpers.module;
        }
      } else {
        // Note this nukes the entire ImportDeclaration so we simply can
        // just grab one of the bindings to remove.
        importDeclaration.remove();
      }
    }
  }

  _warn(expression) {
    let { t, externalizeHelpers, helpers } = this;
    let args = expression.node.expression.arguments;

    let warn;
    if (externalizeHelpers) {
      let ns = helpers.global;
      if (ns) {
        warn = this._createGlobalExternalHelper('warn', args, ns);
      } else {
        warn = this._createExternalHelper('warn', args);
      }
    } else {
      warn = this._createConsoleAPI('warn', args);
    }

    let identifiers = this._getIdentifiers(args);
    this.expressions.push([expression, this._buildLogicalExpressions([], warn)]);
  }

  _deprecate(expression) {
    let { t, externalizeHelpers, helpers } = this;
    let [ message, predicate, metaExpression ] = expression.node.expression.arguments;

    let meta = {
      url: null,
      id: null,
      until: null
    };

    metaExpression.properties.forEach((prop) => {
      let { key, value } = prop;
      meta[key.name] = value.value;
    });

    if (!meta.id) {
      throw new ReferenceError(`deprecate's meta information requires an "id" field.`);
    }

    if (!meta.until) {
      throw new ReferenceError(`deprecate's meta information requires an "until" field.`);
    }

    if (satisfies(this.packageVersion, `${meta.until}`)) {
      expression.remove();
    } else {
      let deprecationMessage = this._generateDeprecationMessage(message, meta);

      let deprecate;
      if (externalizeHelpers) {
        let ns = helpers.global;
        if (ns) {
          deprecate = this._createGlobalExternalHelper('deprecate', [deprecationMessage], ns);
        } else {
          deprecate = this._createExternalHelper('deprecate', [deprecationMessage]);
        }
      } else {
        deprecate = this._createConsoleAPI('warn', [deprecationMessage]);
      }

      this.expressions.push([expression, this._buildLogicalExpressions([predicate], deprecate)]);
    }
  }

  _assert(path) {
    let { t, externalizeHelpers, helpers } = this;
    let args = path.node.expression.arguments;
    let assert;

    if (externalizeHelpers) {
      let ns = helpers.global;
      if (ns) {
        assert = this._createGlobalExternalHelper('assert', args, ns);
      } else {
        assert = this._createExternalHelper('assert', args);
      }
    } else {
      assert = this._createConsoleAPI('assert', args);
    }

    let identifiers = this._getIdentifiers(args);
    this.expressions.push([path, this._buildLogicalExpressions(identifiers, assert)]);
  }

  _getIdentifiers(args) {
    return args.filter((arg) => this.t.isIdentifier(arg));
  }

  _generateDeprecationMessage(message, meta) {
    return this.t.stringLiteral(`DEPRECATED [${meta.id}]: ${message.value}. Will be removed in ${meta.until}.${meta.url ? ` See ${meta.url} for more information.` : ''}`);
  }

  _createGlobalExternalHelper(type, args, ns) {
    let { t } = this;
    return t.callExpression(t.memberExpression(t.identifier(ns), t.identifier(type)), args);
  }

  _createExternalHelper(type, args) {
    let { t } = this;
    return t.callExpression(t.identifier(type), args);
  }

  _createConsoleAPI(type, args) {
    let { t } = this;
    return t.callExpression(t.memberExpression(t.identifier('console'), t.identifier(type)), args);
  }

  _buildLogicalExpressions(identifiers, callExpression) {
    let { t } = this;

    return (binding) => {
      identifiers.unshift(t.identifier(binding));
      identifiers.push(callExpression);
      let logicalExpressions;

        for (let i = 0; i < identifiers.length; i++) {
          let left = identifiers[i];
          let right = identifiers[i + 1];
          if (!logicalExpressions) {
            logicalExpressions = t.logicalExpression('&&', left, right);
          } else if (right) {
            logicalExpressions = t.logicalExpression('&&', logicalExpressions, right)
          }
        }

      return logicalExpressions;
    }
  }
}
