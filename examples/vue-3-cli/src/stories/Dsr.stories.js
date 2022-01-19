import MyButton from './Button.vue';
import ComplexButton from './ComplexButton.vue';

export default {
  title: 'Example/Dynamic Source Rendering',
  component: MyButton,
  argTypes: {
    backgroundColor: { control: 'color' },
    size: { control: { type: 'select', options: ['small', 'medium', 'large'] } },
    onClick: {},
  },
};

const Template = (args) => ({
  // Components used in your story `template` are defined in the `components` object
  components: { MyButton },
  // The story's `args` need to be mapped into the template through the `setup()` method
  setup() {
    return { args };
  },
  // And then the `args` are bound to your component with `v-bind="args"`
  template: '<my-button v-bind="args" v-show="true" />',
});

export const Primary = Template.bind({});
Primary.args = {
  primary: true,
  label: 'Button',
};

export const Nested = (args) => ({
  components: { MyButton },
  setup() {
    return { args };
  },
  template: `
    <div data-some-attr="" data-boolean>
      <p data-another-attr="has-value" aria-hidden="true">Invisibo</p>
      <my-button v-bind="args" primary />
    </div>
  `,
});
Nested.args = {
  label: 'Nested',
};

export const NamedSlot = (args) => ({
  components: { ComplexButton },
  methods: {
    get5() {
      return 5;
    },
  },
  computed: {
    qux() {
      return false;
    },
    // Should not be appeared.
    null() {
      return 3;
    },
  },
  setup() {
    return { args };
  },
  template: `
    <ComplexButton foo="bar" :baz="3 + get5()" :qux="qux" :quux="null">
      <template v-slot:icon>
        <span>i</span>
      </template>
      Button
    </ComplexButton>
  `,
});
