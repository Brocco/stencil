import * as d from '../../../declarations';
import { convertValueToLiteral, createStaticGetter, getDeclarationParameters, removeDecorators } from '../transform-utils';
import ts from 'typescript';
import { DEFAULT_STYLE_MODE, augmentDiagnosticWithNode, buildError, validateComponentTag } from '@utils';
import { CLASS_DECORATORS_TO_REMOVE } from '../remove-stencil-import';


export function componentDecoratorToStatic(config: d.Config, typeChecker: ts.TypeChecker, diagnostics: d.Diagnostic[], cmpNode: ts.ClassDeclaration, newMembers: ts.ClassElement[], componentDecorator: ts.Decorator) {
  removeDecorators(cmpNode, CLASS_DECORATORS_TO_REMOVE);

  const [ componentOptions ] = getDeclarationParameters<d.ComponentOptions>(componentDecorator);
  if (!componentOptions) {
    return;
  }

  if (!validateComponent(config, diagnostics, typeChecker, componentOptions, cmpNode, componentDecorator)) {
    return;
  }

  newMembers.push(createStaticGetter('is', convertValueToLiteral(componentOptions.tag.trim())));

  if (componentOptions.shadow) {
    newMembers.push(createStaticGetter('encapsulation', convertValueToLiteral('shadow')));

  } else if (componentOptions.scoped) {
    newMembers.push(createStaticGetter('encapsulation', convertValueToLiteral('scoped')));
  }

  const defaultModeStyles = [];
  if (componentOptions.styleUrls) {
    if (Array.isArray(componentOptions.styleUrls)) {
      defaultModeStyles.push(...normalizeStyle(componentOptions.styleUrls));
    } else {
      defaultModeStyles.push(...normalizeStyle(componentOptions.styleUrls[DEFAULT_STYLE_MODE]));
    }
  }
  if (componentOptions.styleUrl) {
    defaultModeStyles.push(...normalizeStyle(componentOptions.styleUrl));
  }

  let styleUrls: d.CompilerModeStyles = {};
  if (componentOptions.styleUrls && !Array.isArray(componentOptions.styleUrls)) {
    styleUrls = normalizeStyleUrls(componentOptions.styleUrls);
  }
  if (defaultModeStyles.length > 0) {
    styleUrls[DEFAULT_STYLE_MODE] = defaultModeStyles;
  }

  if (Object.keys(styleUrls).length > 0) {
    newMembers.push(createStaticGetter('originalStyleUrls', convertValueToLiteral(styleUrls)));
    newMembers.push(createStaticGetter('styleUrls', convertValueToLiteral(normalizeExtension(config, styleUrls))));
  }

  let assetsDirs = componentOptions.assetsDirs || [];
  if (componentOptions.assetsDir) {
    assetsDirs = [
      ...assetsDirs,
      componentOptions.assetsDir,
    ];
  }
  if (assetsDirs.length > 0) {
    newMembers.push(createStaticGetter('assetsDirs', convertValueToLiteral(assetsDirs)));
  }
  if (typeof componentOptions.styles === 'string') {
    const styles = componentOptions.styles.trim();
    if (styles.length > 0) {
      newMembers.push(createStaticGetter('styles', convertValueToLiteral(styles)));
    }
  }

}

function validateComponent(config: d.Config, diagnostics: d.Diagnostic[], typeChecker: ts.TypeChecker, componentOptions: d.ComponentOptions, cmpNode: ts.ClassDeclaration, componentDecorator: ts.Node) {
  const extendNode = cmpNode.heritageClauses && cmpNode.heritageClauses.find(c => c.token === ts.SyntaxKind.ExtendsKeyword);
  if (extendNode) {
    const err = buildError(diagnostics);
    err.messageText = `Classes decorated with @Component can not extend from a base class.
    Stencil needs to be able to switch between different base classes in order to implement the different output targets such as: lazy and raw web components.`;
    augmentDiagnosticWithNode(config, err, extendNode);
    return false;
  }

  if (componentOptions.shadow && componentOptions.scoped) {
    const err = buildError(diagnostics);
    err.messageText = `Components cannot be "scoped" and "shadow" at the same time, they are mutually exclusive configurations.`;
    augmentDiagnosticWithNode(config, err, findTagNode('scoped', componentDecorator));
    return false;
  }

  // check if class has more than one decorator
  const otherDecorator = cmpNode.decorators && cmpNode.decorators.find(d => d !== componentDecorator);
  if (otherDecorator) {
    const err = buildError(diagnostics);
    err.messageText = `Classes decorated with @Component can not be decorated with more decorators.
    Stencil performs extensive static analysis on top of your components in order to generate the necessary metadata, runtime decorators at the components level make this task very hard.`;
    augmentDiagnosticWithNode(config, err, otherDecorator);
    return false;
  }

  const tag = componentOptions.tag;
  if (typeof tag !== 'string' || tag.trim().length === 0) {
    const err = buildError(diagnostics);
    err.messageText = `tag missing in component decorator`;
    augmentDiagnosticWithNode(config, err, componentDecorator);
    return false;
  }

  const tagError = validateComponentTag(tag);
  if (tagError) {
    const err = buildError(diagnostics);
    err.messageText = `${tagError}. Please refer to https://html.spec.whatwg.org/multipage/custom-elements.html#valid-custom-element-name for more info.`;
    augmentDiagnosticWithNode(config, err, findTagNode('tag', componentDecorator));
    return false;
  }

  if (!config._isTesting) {
    const nonTypeExports = typeChecker.getExportsOfModule(typeChecker.getSymbolAtLocation(cmpNode.getSourceFile()))
      .filter(symbol => (symbol.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias)) === 0)
      .filter(symbol => symbol.name !== cmpNode.name.text);

    nonTypeExports.forEach(symbol => {
      const err = buildError(diagnostics);
      err.messageText = `To allow efficient bundling, modules using @Component() can only have a single export which is the component class itself.
      Any other exports should be moved to a separate file.
      For further information check out: https://stenciljs.com/docs/module-bundling`;
      const errorNode = symbol.valueDeclaration
        ? symbol.valueDeclaration.modifiers[0]
        : symbol.declarations[0];

      augmentDiagnosticWithNode(config, err, errorNode);
    });
    if (nonTypeExports.length > 0) {
      return false;
    }
  }
  return true;
}

function findTagNode(propName: string, node: ts.Node) {
  if (ts.isDecorator(node) && ts.isCallExpression(node.expression)) {
    const arg = node.expression.arguments[0];
    if (ts.isObjectLiteralExpression(arg)) {
      arg.properties.forEach(p => {
        if (ts.isPropertyAssignment(p)) {
          if (p.name.getText() === propName) {
            node = p.initializer;
          }
        }
      });
    }
  }
  return node;
}

function normalizeExtension(config: d.Config, styleUrls: d.CompilerModeStyles): d.CompilerModeStyles {
  const compilerStyleUrls: d.CompilerModeStyles = {};
  Object.keys(styleUrls).forEach(key => {
    compilerStyleUrls[key] = styleUrls[key].map(s => useCss(config, s));
  });
  return compilerStyleUrls;
}

function useCss(config: d.Config, stylePath: string) {
  const sourceFileDir = config.sys.path.dirname(stylePath);
  const sourceFileExt = config.sys.path.extname(stylePath);
  const sourceFileName = config.sys.path.basename(stylePath, sourceFileExt);
  return config.sys.path.join(sourceFileDir, sourceFileName + '.css');
}

function normalizeStyleUrls(styleUrls: d.ModeStyles): d.CompilerModeStyles {
  const compilerStyleUrls: d.CompilerModeStyles = {};
  Object.keys(styleUrls).forEach(key => {
    compilerStyleUrls[key] = normalizeStyle(styleUrls[key]);
  });
  return compilerStyleUrls;
}

function normalizeStyle(style: string | string[] | undefined): string[] {
  if (Array.isArray(style)) {
    return style;
  }
  if (style) {
    return [style];
  }
  return [];
}
