// plugins/4ge/lib/design-suite-visual.cjs
'use strict';

const A11Y_RULES = [
  { id: 'a11y-alt', rule: 'All images require alt text. Decorative images use alt=""', severity: 'error' },
  { id: 'a11y-contrast', rule: 'Text must meet WCAG 2.1 AA contrast ratio (4.5:1 normal, 3:1 large)', severity: 'error' },
  { id: 'a11y-keyboard', rule: 'All interactive elements must be keyboard accessible (tab, enter, escape)', severity: 'error' },
  { id: 'a11y-aria', rule: 'Use semantic HTML first. ARIA attributes only when semantic elements are insufficient', severity: 'warning' },
  { id: 'a11y-focus', rule: 'Focus indicators must be visible. Never remove outline without replacement', severity: 'error' },
];

const RESPONSIVE_PATTERNS = [
  { name: 'mobile-first', pattern: 'Start with mobile layout, add breakpoints for larger screens (min-width)', description: 'Tailwind default: sm: md: lg: xl: 2xl:' },
  { name: 'container-queries', pattern: 'Use @container for component-scoped responsive design', description: '@container (min-width: 400px) { ... }' },
  { name: 'fluid-typography', pattern: 'Use clamp() for responsive font sizes', description: 'font-size: clamp(1rem, 2.5vw, 2rem)' },
  { name: 'aspect-ratio', pattern: 'Use aspect-ratio for media containers', description: 'aspect-ratio: 16/9' },
];

const TAILWIND_REFS = {
  spacing: 'p-{0-96}, m-{0-96}, gap-{0-96} — 0.25rem increments',
  colors: 'bg-{color}-{50-950}, text-{color}-{50-950}, border-{color}-{50-950}',
  layout: 'flex, grid, container mx-auto, max-w-{size}',
  typography: 'text-{xs-9xl}, font-{thin-black}, leading-{tight-loose}, tracking-{tighter-widest}',
  effects: 'shadow-{sm-2xl}, rounded-{sm-full}, opacity-{0-100}, backdrop-blur-{sm-3xl}',
  animations: 'animate-{spin,ping,pulse,bounce}, transition-{all,colors,opacity,shadow,transform}',
};

const FRAMEWORK_PATTERNS = {
  react: [
    'Use functional components with hooks (not class components)',
    'Extract reusable UI into components/ directory',
    'Use forwardRef for components that accept ref props',
    'Memoize expensive renders with React.memo or useMemo',
    'Use Suspense boundaries for async components',
  ],
  vue: [
    'Use Composition API with <script setup> (not Options API)',
    'Extract composables to composables/ directory',
    'Use defineProps/defineEmits for component contracts',
    'Use <Teleport> for modals and overlays',
    'Use v-model for two-way binding on form inputs',
  ],
  svelte: [
    'Use reactive declarations ($:) for derived state',
    'Extract actions for reusable DOM behaviors',
    'Use {#each} with keyed items for lists',
    'Use slots for component composition',
    'Use transitions and animations via svelte/transition',
  ],
  generic: [
    'Separate layout from component logic',
    'Use CSS custom properties for theming',
    'Keep component files under 200 lines',
    'Extract shared styles into utility classes',
  ],
};

const VISUAL_WORKFLOW = [
  { step: 1, name: 'Sketch', description: 'Define layout structure, key elements, spacing' },
  { step: 2, name: 'Implement', description: 'Build with semantic HTML + Tailwind utilities' },
  { step: 3, name: 'Accessibility', description: 'Apply a11y rules, test keyboard nav, add ARIA' },
  { step: 4, name: 'Responsive', description: 'Verify mobile-first breakpoints, test at all sizes' },
];

/**
 * Assembles the visual mode toolkit based on project config.
 *
 * @param {object} config - Runtime config (.4ge/config.json contents)
 * @returns {object} Toolkit with tailwind, a11y, responsive, framework_refs, workflow
 */
function assembleVisualToolkit(config) {
  const framework = (config.detected && config.detected.framework) || '';
  const normalizedFramework = ['react', 'vue', 'svelte'].includes(framework) ? framework : 'generic';

  return {
    tailwind: TAILWIND_REFS,
    a11y: A11Y_RULES,
    responsive: RESPONSIVE_PATTERNS,
    framework_refs: {
      framework: normalizedFramework,
      patterns: FRAMEWORK_PATTERNS[normalizedFramework],
    },
    workflow: VISUAL_WORKFLOW,
  };
}

module.exports = { assembleVisualToolkit, A11Y_RULES, RESPONSIVE_PATTERNS, TAILWIND_REFS, FRAMEWORK_PATTERNS };
