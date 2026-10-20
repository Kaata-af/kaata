// Execute Home's real rail effect with the installed RN JS spring algorithm.
// Node storage, native driver selection and frame delivery are explicit boundaries.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const mobile = path.resolve(__dirname, '../..');
const req = createRequire(path.join(mobile, 'package.json'));
const ts = req('typescript');
const babel = req('@babel/core');
const filename = path.join(mobile, 'app/index.tsx');
const source = fs.readFileSync(filename, 'utf8');
const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let railEffect, initialValue, springConfig;
function walk(node) {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect'
    && node.arguments[0]?.getText(ast).includes('Animated.spring(translateX')) railEffect = node;
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'translateX') initialValue = node.initializer;
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'RAIL_SPRING') springConfig = node.initializer;
  ts.forEachChild(node, walk);
}
walk(ast);
assert.ok(railEffect && initialValue && springConfig, 'Actual rail effect, initial transform and spring policy must exist');
const effectDependencies = railEffect.arguments[1].elements.map((node) => node.getText(ast));
assert.deepEqual(effectDependencies, ['direction', 'screenWidth', 'translateX', 'searching'],
  'Direction, rotation and search changes must clean up and restart the resting animation');
const moduleFactory = { exports: {} };
const extracted = 'module.exports={initial:(Animated,useRef)=>(' + initialValue.getText(ast) + '),'
  + 'effect:(useEffect,Animated,direction,screenWidth,translateX,searching)=>{const RAIL_SPRING='
  + springConfig.getText(ast) + ';' + railEffect.getText(ast) + ';}};';
vm.runInNewContext(ts.transpileModule(extracted, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText, { module: moduleFactory, exports: moduleFactory.exports });

let now = 0, nextFrame = 0, executed = 0;
const frames = new Map();
const context = vm.createContext({ __DEV__: false, Date: { now: () => now },
  setTimeout: () => assert.fail('Home spring has no delay'), clearTimeout: () => {},
  requestAnimationFrame: (work) => { const id = ++nextFrame; frames.set(id, work); return id; },
  cancelAnimationFrame: (id) => frames.delete(id),
});
vm.runInContext('global = globalThis', context);
const hashes = {};
function evaluate(relative, requireDependency) {
  const file = path.join(mobile, 'node_modules/react-native/Libraries/Animated', relative);
  const content = fs.readFileSync(file, 'utf8');
  hashes[relative] = crypto.createHash('sha256').update(content).digest('hex');
  const code = babel.transformSync(content, { filename: file, configFile: false, babelrc: false,
    plugins: [req.resolve('babel-plugin-syntax-hermes-parser'),
      req.resolve('@babel/plugin-transform-flow-strip-types'),
      req.resolve('@babel/plugin-transform-modules-commonjs')],
  }).code;
  const module = { exports: {} };
  vm.runInContext('(function(module,exports,require){' + code + '\n})', context,
    { filename: file })(module, module.exports, requireDependency);
  return module.exports;
}
const nativeHelper = { shouldUseNativeDriver: (config) => {
  assert.equal(config.useNativeDriver, false, 'Every actual Home spring remains JS-driven');
  return false;
} };
const BaseAnimation = evaluate('animations/Animation.js', (id) => {
  if (id.endsWith('/NativeAnimatedHelper')) return nativeHelper;
  if (id.endsWith('/ReactNativeFeatureFlags')) return {};
  if (id === '../nodes/AnimatedProps') return class {};
  assert.fail('Unexpected installed base animation dependency: ' + id);
}).default;
const config = evaluate('SpringConfig.js', (id) => assert.fail(id));
const SpringAnimation = evaluate('animations/SpringAnimation.js', (id) => {
  if (id === './Animation') return BaseAnimation;
  if (id === '../SpringConfig') return config;
  if (id === '../nodes/AnimatedColor') return class {};
  if (id === 'invariant') return (condition, message) => assert.ok(condition, message);
  assert.fail('Unexpected installed spring dependency: ' + id);
}).default;
const animations = [], completions = [];
class Value {
  constructor(initial) { this.value = initial; this.animation = null; }
  setValue(next) { this.animation?.stop(); this.animation = null; this.value = next; }
}
const Animated = { Value, spring: (value, options) => {
  const animation = new SpringAnimation(options);
  animations.push({ animation, options });
  return {
    start: () => {
      const previous = value.animation;
      previous?.stop();
      value.animation = animation;
      animation.start(value.value, (next) => { value.value = next; },
        (result) => {
          completions.push(result.finished);
          if (value.animation === animation) value.animation = null;
        }, previous, { __isNative: false });
    },
    stop: () => animation.stop(),
  };
} };
const translation = moduleFactory.exports.initial(Animated, (value) => ({ current: value }));
assert.equal(translation.value, 0, 'Actual initial Animated.Value puts Collect on-screen on the first paint');
let cleanup;
function mount(direction, width = 390, searching = false) {
  cleanup?.();
  moduleFactory.exports.effect((effect) => { cleanup = effect(); }, Animated,
    direction, width, translation, searching);
  assert.ok(frames.size <= 1, 'The actual effect can own at most one spring frame');
}
function frame() {
  assert.ok(frames.size <= 1, 'No accumulating retry or idle frame chains');
  const current = [...frames.values()];
  frames.clear(); now += 16;
  current.forEach((work) => { executed++; work(now); });
}
function settle(target) {
  let count = 0;
  while (frames.size && count++ < 600) frame();
  assert.equal(frames.size, 0, 'Installed spring finishes within a bounded number of frames');
  assert.equal(translation.value, target, 'Installed spring reaches the exact resting page');
  const after = executed;
  for (let i = 0; i < 120; i++) frame();
  assert.equal(executed, after, 'A settled rail schedules no idle animation work');
  return count;
}
mount('collect');
assert.equal(frames.size, 0, 'Initial resting Collect paint needs no follow-up animation frame');
mount('pay');
assert.equal(animations.at(-1).options.toValue, -390, 'Actual Pay tab effect animates to physical right page');
frame(); frame();
assert.ok(translation.value < 0 && translation.value > -390, 'Installed spring moves between the real page positions');
mount('collect');
assert.ok(completions.includes(false), 'A rapid tab change stops the obsolete spring');
const backFrames = settle(0);
mount('pay');
const payFrames = settle(-390);
mount('pay', 844);
const rotationFrames = settle(-844);
mount('collect', 844);
frame(); frame();
mount('pay', 844, true);
assert.equal(translation.value, -844, 'Opening search puts the remembered page directly at rest');
assert.equal(frames.size, 0, 'Search stops the live rail animation');
const beforeSearch = animations.length;
for (let i = 0; i < 120; i++) frame();
assert.equal(animations.length, beforeSearch, 'Search has no hidden animation loop');
mount('pay', 844, false);
settle(-844);
mount('collect');
frame();
cleanup();
const unmountedValue = translation.value;
assert.equal(frames.size, 0, 'Unmount cleanup cancels the pending JS frame');
for (let i = 0; i < 120; i++) frame();
assert.equal(translation.value, unmountedValue, 'Unmounted spring never resumes');
console.log(JSON.stringify({ allPassed: true, hostOnly: true,
  installedRN: req('react-native/package.json').version,
  framesToRest: { rapidSwitch: backFrames, pay: payFrames, rotation: rotationFrames },
  executed, pendingFrames: frames.size,
  sourceSha256: { ...hashes, 'app/index.tsx': crypto.createHash('sha256').update(source).digest('hex') },
  boundaryStubs: ['React effect scheduling', 'Animated node storage/dispatch', 'native driver selection', 'host frame delivery'],
  limitation: 'Actual Home effect and installed JS spring algorithm/lifecycle; Android rendering and frame timing require phone QA.' }, null, 2));
