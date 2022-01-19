/* eslint no-param-reassign: ["error", { "props": false }], consistent-return: "off" */

import { StoryContext } from '@storybook/csf';
import { addons, useEffect } from '@storybook/addons';
import { logger } from '@storybook/client-logger';
import { VueFramework } from '@storybook/vue3';
import { getCurrentInstance, ComponentInternalInstance } from '@vue/runtime-core';
import {
  transform,
  baseParse,
  DirectiveNode,
  ExpressionNode,
  ElementNode,
  TextNode,
  InterpolationNode,
  locStub,
  createSimpleExpression,
  createStructuralDirectiveTransform,
  AttributeNode,
  Node,
  RootNode,
  SimpleExpressionNode,
  CommentNode,
} from '@vue/compiler-core';

import { SourceType, SNIPPET_RENDERED } from '../../shared';

// TODO: Tests (see ../vue/sourceDecorator.test.ts)

// Wrap tag when character count exceeds these values
const OUTER_WRAP_THRESHOLD = 60;
const CHILDREN_WRAP_THRESHOLD = 30;

export const skipSourceRender = (context: StoryContext<VueFramework>) => {
  const sourceParams = context?.parameters.docs?.source;
  const isArgsStory = context?.parameters.__isArgsStory;

  // always render if the user forces it
  if (sourceParams?.type === SourceType.DYNAMIC) {
    return false;
  }

  // never render if the user is forcing the block to render code, or
  // if the user provides code, or if it's not an args story.
  return !isArgsStory || sourceParams?.code || sourceParams?.type === SourceType.CODE;
};

export const sourceDecorator = (storyFn: any, context: StoryContext<VueFramework>) => {
  const story = storyFn();
  const skip = skipSourceRender(context);

  let snippet = '';

  useEffect(() => {
    if (!skip) {
      channel.emit(SNIPPET_RENDERED, (context || {}).id, snippet);
    }
  });

  // See ../react/jsxDecorator.tsx
  if (skipSourceRender(context)) {
    return story;
  }

  const channel = addons.getChannel();

  return {
    components: {
      Story: story,
    },
    // We need to wait until the wrapper component to be mounted so Vue runtime generate a VNode tree.
    mounted() {
      try {
        const storyComponent = lookupStoryInstance(getCurrentInstance());
        if (!storyComponent) {
          return;
        }

        // TODO: Refactor so we don't need to access these complicated properties, or add explanation
        const storyObject = storyComponent.subTree.type;
        if (
          typeof storyObject !== 'object' ||
          !('template' in storyObject) ||
          typeof storyObject.template !== 'string'
        ) {
          return;
        }

        const ast = baseParse(storyObject.template);

        transform(ast, {
          nodeTransforms: [
            createStructuralDirectiveTransform('bind', (node, directive, ctx) => {
              if (!('content' in directive.exp)) {
                // Skip `v-bind` (invalid) or `vind-bind="<CompoundExpression>"` (I don't know what the CompoundExpression is)
                // FIXME: Please remove "(I don't know~)" section from and add explainer of CompoundExpression to above comment
                return;
              }

              const instance = storyComponent.subTree.component.proxy as any;

              // Single property binding (`:foo="bar"`), do not transform
              if (directive.arg && 'content' in directive.arg) {
                // Check if it's possible to resolve the value
                if (shouldResolve(directive.exp.content) && directive.exp.content in instance) {
                  const name = directive.arg.content;
                  const value = instance[directive.exp.content];

                  return () => {
                    injectProp(node, name, value);
                  };
                }

                return () => {
                  node.props.push(directive);
                };
              }

              const target = instance[directive.exp.content];
              if (!target || typeof target !== 'object') {
                // the property does not exist or is not an object, cannot process
                return;
              }

              // We don't need to remove the directive as it's already removed from the `node`
              const entries = Object.entries(target);

              return () => {
                for (let i = 0, l = entries.length; i < l; i += 1) {
                  injectProp(node, entries[i][0], entries[i][1]);
                }
              };
            }),
          ],
        });

        snippet = serialize(ast);

        return;
      } catch (e) {
        logger.warn(`Failed to generate dynamic story source: ${e}`);
      }
    },
    template: '<story />',
  };
};

function shouldResolve(content: string): boolean {
  // keywords
  switch (content) {
    case 'true':
    case 'false':
    case 'null':
    case 'undefined':
    case 'NaN':
    case 'Infinity':
      return false;
    default:
      return !(/^\d/.test(content) || /[-+.(/[{<>?!%]/.test(content));
  }
}

function createTextNode(content: string): TextNode {
  return {
    // https://github.com/vuejs/core/blob/ae4b0783d78670b6e942ae2a4e3ec6efbbffa158/packages/compiler-core/src/ast.ts#L28
    type: 2,
    content,
    loc: locStub,
  };
}

function createAttributeNode(name: string, text?: TextNode): AttributeNode {
  return {
    // https://github.com/vuejs/core/blob/ae4b0783d78670b6e942ae2a4e3ec6efbbffa158/packages/compiler-core/src/ast.ts#L32
    type: 6,
    name,
    loc: locStub,
    value: text,
  };
}

function createPropBindingNode(propName: string, expr: ExpressionNode): DirectiveNode {
  return {
    // https://github.com/vuejs/core/blob/ae4b0783d78670b6e942ae2a4e3ec6efbbffa158/packages/compiler-core/src/ast.ts#L33
    type: 7,
    name: 'bind',
    exp: expr,
    arg: createSimpleExpression(propName, true),
    modifiers: [],
    loc: locStub,
  };
}

/**
 * Inject a component property into Element (native element or component).
 * Complex data types and functions will be ignored.
 */
function injectProp(node: ElementNode, name: string, value: unknown): void {
  if (typeof value === 'string') {
    node.props.push(createAttributeNode(name, createTextNode(value)));
    return;
  }

  if (typeof value === 'boolean') {
    if (value) {
      // Prop name only
      node.props.push(createAttributeNode(name));
    } else {
      node.props.push(createPropBindingNode(name, createSimpleExpression('false', false)));
    }
    return;
  }

  if (typeof value === 'number' || typeof value === 'object') {
    // TODO: More intuitive serialization, rule needs to be defined
    node.props.push(
      createPropBindingNode(
        name,
        createSimpleExpression(JSON.stringify(value).replace(/"/g, "'"), false)
      )
    );
    return;
  }

  if (typeof value === 'symbol') {
    // TODO: How should we handle Symbol?
    node.props.push(createAttributeNode(name, createTextNode('<Symbol>')));
  }

  // Skip exotic objects, functions.
}

function serialize(node: Node): string {
  // We use hard coded numbers due to @vue/compiler-core exports these enums as `const enum`
  // so we can't use them as we transpile TS files with `--isolatedModules` enabled.
  // (re-declare const enum does not work, of course)
  // https://github.com/vuejs/core/blob/ae4b0783d78670b6e942ae2a4e3ec6efbbffa158/packages/compiler-core/src/ast.ts#L25
  switch (node.type) {
    // ROOT
    case 0: {
      return (node as RootNode).children.map(serialize).join('\n');
    }
    // ELEMENT
    case 1: {
      const el = node as ElementNode;

      const children = (el.children || []).map(serialize);

      const props = el.props.map(serialize);

      const outerLength =
        el.tag.length * 2 + props.reduce((total, str) => total + str.length, 0) + props.length + 5;

      // TODO: More smart wrapping, please
      const wrapOuter = outerLength > OUTER_WRAP_THRESHOLD;
      const [start, end] = wrapOuter
        ? [`<${el.tag}\n${props.map((str) => `  ${str}\n`).join('')}>`, `</${el.tag}>`]
        : [`<${el.tag}${props.map((str) => ` ${str}`).join('')}>`, `</${el.tag}>`];

      if (!children.length && el.isSelfClosing) {
        return `${start.slice(0, -1)}/>`;
      }

      const innerLength = children.reduce((total, str) => total + str.length, 0);

      // TODO: Trim whitespace from TextNode that is the direct child (newline == space when `white-space: normal`)
      if (wrapOuter || innerLength > CHILDREN_WRAP_THRESHOLD) {
        return `${start}\n${children.map((str) => `  ${str}\n`).join('')}${end}`;
      }

      return start + children.join('') + end;
    }
    // TEXT
    case 2: {
      return (node as TextNode).content;
    }
    // COMMENT
    case 3: {
      return `<!--${(node as CommentNode).content}-->`;
    }
    // SIMPLE_EXPRESSION
    case 4: {
      return (node as SimpleExpressionNode).content;
    }
    // INTERPOLATION
    case 5: {
      return `{{ ${node as InterpolationNode} }}`;
    }
    // ATTRIBUTE
    case 6: {
      const attr = node as AttributeNode;
      if (!attr.value) {
        return attr.name;
      }

      return `${attr.name}="${attr.value.content}"`;
    }
    // DIRECTIVE
    case 7: {
      const dir = node as DirectiveNode;
      // `:foo="bar"` shorthand
      if (dir.name === 'bind' && dir.arg) {
        return `:${serialize(dir.arg)}="${serialize(dir.exp)}"`;
      }

      let ret = `v-${dir.name}`;

      if (dir.arg) {
        ret += `:${serialize(dir.arg)}`;
      }

      if (dir.modifiers && dir.modifiers.length > 0) {
        ret += dir.modifiers.map((m) => `.${m}`).join('');
      }

      if (dir.exp) {
        ret += `="${serialize(dir.exp)}"`;
      }

      return ret;
    }
    // We can ignore the rest, as they are for template compilation and Vue internal stuff
    default:
      return '';
  }
}

/**
 * Traverse component instance and returns the story's one.
 * Returns `null` when unable to find story instance.
 *
 * FIXME: This does not work with CSF3, possibly due to the difference of component hierarchy
 * TODO: More stable and reliable solution needed
 *
 * # How to detect story component?
 *
 * When a component instance has `story` component inside `components` registry,
 * that is an component instance of a decorator. Slotted instance without `story`
 * component registered is the story user wrote.
 */
function lookupStoryInstance(
  instance: ComponentInternalInstance
): ComponentInternalInstance | null {
  if (
    typeof instance.type === 'object' &&
    'components' in instance.type &&
    instance.type.components &&
    'story' in instance.type.components
  ) {
    if (!instance.subTree.component) {
      // This is the final decorator. Now, grab the user story.
      const storyComponent = instance.type.components.story;

      if (Array.isArray(instance.subTree.children)) {
        const found = instance.subTree.children.find((child) => {
          if (typeof child === 'object' && 'type' in child) {
            return child.component.type === storyComponent;
          }

          return false;
        });

        return Array.isArray(found) || typeof found !== 'object' ? null : found.component;
      }

      return null;
    }

    // Now, the `instance.subTree` is VNode of decorator. Dig one-level deeper.
    return lookupStoryInstance(instance.subTree.component);
  }

  // No decorators
  return instance;
}
