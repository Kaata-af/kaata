// Host-only causality regression. Execute installed native-path algorithms;
// replace only React lifecycle, shared-value storage and native/JNI boundaries.
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
const installed = path.join(mobile, 'node_modules');
const names = {
  core: 'react-native-reanimated/src/core.ts',
  mappers: 'react-native-reanimated/src/mappers.ts',
  shared: 'react-native-reanimated/src/isSharedValue.ts',
  frames: 'react-native-worklets/src/runLoop/uiRuntime/requestAnimationFrame.ts',
  reaction: 'react-native-reanimated/src/hook/useAnimatedReaction.ts',
  style: 'react-native-reanimated/src/hook/useAnimatedStyle.ts',
  styleUtils: 'react-native-reanimated/src/hook/utils.ts',
  timing: 'react-native-reanimated/src/animation/timing.ts',
  easing: 'react-native-reanimated/src/Easing.ts',
  valueSetter: 'react-native-reanimated/src/valueSetter.ts',
};
const sources = Object.fromEntries(Object.entries(names).map(([key, name]) =>
  [key, fs.readFileSync(path.join(installed, name), 'utf8')]));
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const hashes = Object.fromEntries(Object.values(names).map((name) =>
  [name, sha(fs.readFileSync(path.join(installed, name)))]));

function sharedValue(initial) {
  let value = initial;
  const listeners = new Map();
  const shared = { _isReanimatedSharedValue: true,
    addListener: (id, callback) => listeners.set(id, callback),
    removeListener: (id) => listeners.delete(id),
    listeners,
  };
  Object.defineProperty(shared, 'value', {
    get: () => value,
    set: (next) => { if (Object.is(value, next)) return; value = next; for (const callback of listeners.values()) callback(value); },
  });
  return shared;
}

function createRuntime() {
  const nativeFrames = [], uiTasks = [], microtasks = [], effects = [];
  const registrations = new Map();
  let now = 0;
  const context = vm.createContext({ __DEV__: false, performance: { now: () => now },
    queueMicrotask: (callback) => microtasks.push(callback),
    __callMicrotasks: () => { while (microtasks.length) microtasks.shift()(); },
    __nativeRequestAnimationFrame: (callback) => nativeFrames.push(callback),
  });
  vm.runInContext('global = globalThis', context);
  function evaluate(key, requireDependency) {
    const module = { exports: {} };
    const code = ts.transpileModule(sources[key], { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    } }).outputText;
    vm.runInContext('(function(exports, require, module) {' + code + '\n})', context,
      { filename: path.join(installed, names[key]) })(module.exports, requireDependency, module);
    return module.exports;
  }
  function unexpected(id) { assert.fail('Unstubbed installed dependency: ' + id); }
  evaluate('frames', unexpected).setupRequestAnimationFrame();
  const stats = { rafRequested: 0, rafExecuted: 0, rafPending: 0,
    finalizerRequested: 0, finalizerExecuted: 0, finalizerPending: 0 };
  const actualRaf = context.requestAnimationFrame;
  context.requestAnimationFrame = (callback) => {
    stats.rafRequested++; stats.rafPending++;
    return actualRaf((timestamp) => { stats.rafPending--; stats.rafExecuted++; callback(timestamp); });
  };
  const actualFinalizer = context.requestAnimationFrameFinalizer;
  context.requestAnimationFrameFinalizer = (callback) => {
    stats.finalizerRequested++; stats.finalizerPending++;
    return actualFinalizer(() => { stats.finalizerPending--; stats.finalizerExecuted++; callback(); });
  };
  const isSharedValue = evaluate('shared', unexpected);
  const mappers = evaluate('mappers', (id) => {
    if (id === 'react-native-worklets') return { scheduleOnUI: (callback) => uiTasks.push(callback) };
    if (id === './common') return { IS_JEST: false, SHOULD_BE_USE_WEB: false };
    if (id === './isSharedValue') return isSharedValue;
    return unexpected(id);
  });
  const core = evaluate('core', (id) => {
    if (id === 'react-native-is-edge-to-edge') return { isEdgeToEdge: () => false };
    if (id === 'react-native-worklets') return { createSerializable: (callback) => callback };
    if (id === './common') return { logger: { warn: unexpected } };
    if (id === './mappers') return mappers;
    if (id === './mutables') return { makeMutable: unexpected };
    if (id === './SensorContainer') return { SensorContainer: class {} };
    if (id === './ReanimatedModule') return { ReanimatedModule: {
      registerEventHandler: (callback) => { const id = registrations.size + 1; registrations.set(id, callback); return id; },
      unregisterEventHandler: (id) => registrations.delete(id),
    } };
    return unexpected(id);
  });
  const reaction = evaluate('reaction', (id) => {
    if (id === 'react') return { useEffect: (callback) => effects.push(callback) };
    if (id === '../common') return { SHOULD_BE_USE_WEB: false };
    if (id === '../core') return core;
    if (id === './useSharedValue') return { useSharedValue: sharedValue };
    return unexpected(id);
  });
  function flush(count) {
    for (let index = 0; index < count; index++) {
      assert.equal(nativeFrames.length, 1, 'Actual scheduler has one native frame callback');
      now += 20;
      nativeFrames.shift()(now);
      assert.equal(nativeFrames.length, 1);
    }
  }
  function drainUI() { while (uiTasks.length) uiTasks.shift()(); }
  let delivered = 0;
  const handler = core.registerEventHandler(() => delivered++, 'onScroll', 42);
  return { context, stats, core, mappers, reaction, effects, flush, drainUI, evaluate,
    emit: (count) => { for (let index = 0; index < count; index++) registrations.get(handler)(now, { index }); },
    delivered: () => delivered,
  };
}

const control = createRuntime();
assert.equal(control.context.__mapperRun, undefined, 'Import and event registration do not initialize mappers');
control.flush(10);
assert.equal(control.stats.rafPending, 0);
control.emit(7);
control.flush(100);
assert.equal(control.stats.rafExecuted, 700);
assert.equal(control.stats.rafPending, 7, 'Each event leaves an idle retry chain while no registry exists');
control.emit(3);
control.flush(20);
assert.equal(control.stats.rafExecuted, 900);
assert.equal(control.stats.rafPending, 10, 'New events accumulate additional recurring retries');
const noMapper = { ...control.stats, delivered: control.delivered() };
let mapperExecutions = 0;
const mapperId = control.mappers.startMapper(() => mapperExecutions++);
assert.equal(control.context.__mapperRun, undefined, 'UI schedule boundary is explicit');
control.drainUI();
assert.equal(typeof control.context.__mapperRun, 'function');
control.flush(1);
assert.equal(control.stats.rafPending, 0, 'The actual registry terminates all old retry chains');
assert.equal(mapperExecutions, 1);
const rafRequests = control.stats.rafRequested;
control.emit(1000);
control.flush(200);
assert.equal(control.stats.rafRequested, rafRequests);
assert.equal(control.stats.rafPending, 0);
assert.equal(control.stats.finalizerPending, 1, 'One native registry finalizer stays bounded');
assert.equal(mapperExecutions, 1, 'Clean mapper is not rerun by idle frames');
control.mappers.stopMapper(mapperId);
control.drainUI();
control.emit(100);
control.flush(100);
assert.equal(typeof control.context.__mapperRun, 'function');
assert.equal(control.stats.rafPending, 0);
assert.equal(control.stats.finalizerPending, 1);
assert.equal(control.delivered(), 1110);

// Extract the real unconditional Home reaction and apply the installed Worklets
// transform: its closure metadata must make the real hook subscribe to the lease.
const homeFile = path.join(mobile, 'app/index.tsx');
const homeSource = fs.readFileSync(homeFile, 'utf8');
const homeAst = ts.createSourceFile(homeFile, homeSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const home = homeAst.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'HomeScreen');
assert.ok(home?.body, 'Actual Home component must exist');
const importDeclaration = homeAst.statements.find((node) => ts.isImportDeclaration(node)
  && node.moduleSpecifier.text === 'react-native-reanimated');
assert.ok(importDeclaration?.importClause?.namedBindings?.elements.some((node) =>
  node.name.text === 'useAnimatedReaction' && (node.propertyName?.text ?? node.name.text) === 'useAnimatedReaction'),
'Home must import the supported public reaction hook');
const calls = [];
function walk(node) {
  if (ts.isCallExpression(node) && node.expression.getText(homeAst) === 'useAnimatedReaction') calls.push(node);
  ts.forEachChild(node, walk);
}
walk(home.body);
assert.equal(calls.length, 1, 'One useful actual Home reaction, not a test-only mapper');
const call = calls[0];
assert.ok(ts.isExpressionStatement(call.parent) && call.parent.parent === home.body,
  'Reaction must mount unconditionally in Home, including while gestures are blocked');
function noEarlierHomeReturn(node) {
  if (node !== home && ts.isFunctionLike(node)) return;
  assert.ok(!ts.isReturnStatement(node) || node.getStart(homeAst) > call.getStart(homeAst),
    'Reaction must precede every Home early return');
  ts.forEachChild(node, noEarlierHomeReturn);
}
noEarlierHomeReturn(home);
const source = 'module.exports=(useAnimatedReaction,homeSwipeUILease,homeSwipeStroke,homeSwipeOffset,cancelAnimation,withTiming,ReduceMotion)=>{' + call.getText(homeAst) + ';};';
const transformed = babel.transformSync(source, { filename: homeFile, configFile: false, babelrc: false,
  presets: [[req.resolve('@babel/preset-typescript'), { allExtensions: true, isTSX: true }]],
  plugins: [req.resolve('react-native-worklets/plugin')],
}).code;

const hooked = createRuntime();
hooked.emit(5);
hooked.flush(50);
assert.equal(hooked.stats.rafPending, 5);
const factory = { exports: {} };
vm.runInContext('(function(module) {' + transformed + '\n})', hooked.context)(factory);
const lease = sharedValue({ epoch: 8, from: 'collect', scope: 'one', blocked: false, reducedMotion: false });
const offset = sharedValue(0);
const timingCalls = [];
const initialStroke = { epoch: 7, from: 'collect', blocked: false, activated: true, x: 13 };
const stroke = sharedValue(initialStroke);
let capturedPrepare, capturedReact;
factory.exports((prepare, react, dependencies) => {
  capturedPrepare = prepare; capturedReact = react;
  assert.equal(typeof prepare.__workletHash, 'number', 'Real prepare is a transformed UI worklet');
  assert.equal(typeof react.__workletHash, 'number', 'Real reaction is a transformed UI worklet');
  assert.ok(Object.values(prepare.__closure).includes(lease), 'Actual hook must observe the live UI lease');
  assert.ok(!Object.values(prepare.__closure).includes(stroke), 'Reaction must not feed its stroke writes back into its prepare input');
  hooked.reaction.useAnimatedReaction(prepare, react, dependencies);
}, lease, stroke, offset, () => {}, (target, config) => { timingCalls.push(config); return target; }, { System: 'system' });
assert.equal(hooked.effects.length, 1, 'Installed reaction mounts one mapper effect');
const cleanup = hooked.effects[0]();
hooked.drainUI();
assert.equal(lease.listeners.size, 1, 'Actual mapper registry subscribes to the lease');
hooked.flush(1);
assert.equal(hooked.stats.rafPending, 0, 'Supported Home hook clears the accumulated retry chains');
assert.equal(stroke.value.blocked, true, 'A stale in-progress stroke is invalidated on UI');
assert.equal(stroke.value.epoch, 7);
assert.equal(stroke.value.x, 13, 'Invalidation preserves the rest of the stroke');
const alreadyBlocked = stroke.value;
lease.value = { ...lease.value, epoch: 9, from: 'pay' };
hooked.flush(1);
assert.equal(stroke.value, alreadyBlocked, 'Already blocked stroke is not repeatedly written');
assert.equal(timingCalls.length, 1, 'Committed same-scope direction change starts one finite entrance');
assert.equal(timingCalls[0].duration, 170);
assert.equal(timingCalls[0].reduceMotion, 'system');
stroke.value = { epoch: 9, from: 'pay', blocked: false, activated: true };
const currentStroke = stroke.value;
lease.value = { ...lease.value, epoch: 9, from: 'pay' };
hooked.flush(1);
assert.equal(stroke.value, currentStroke, 'Same-epoch current stroke is preserved');
lease.value = { ...lease.value, epoch: 10, from: 'collect' };
hooked.flush(1);
assert.equal(stroke.value.blocked, true, 'Later lease invalidation cancels a fresh active stroke');
const entrances = timingCalls.length;
for (const next of [{ scope: 'two', from: 'pay' }, { blocked: true, from: 'collect' },
  { blocked: false, reducedMotion: true, from: 'pay' }]) {
  offset.value = 12;
  lease.value = { ...lease.value, ...next, epoch: lease.value.epoch + 1 };
  hooked.flush(1);
  assert.equal(offset.value, 0, 'Scope, blocking and live reduced-motion changes reset presentation');
}
assert.equal(timingCalls.length, entrances, 'Invalidation never animates content from another scope or overlay');
const afterHookRequests = hooked.stats.rafRequested;
hooked.emit(1000);
hooked.flush(200);
assert.equal(hooked.stats.rafRequested, afterHookRequests, 'New events never regrow retry chains after the hook mounts');
assert.equal(hooked.stats.rafPending, 0);
assert.equal(hooked.stats.finalizerPending, 1);
cleanup();
hooked.drainUI();
assert.equal(lease.listeners.size, 0, 'Actual effect cleanup stops mapper subscriptions');
hooked.emit(100);
hooked.flush(100);
assert.equal(hooked.stats.rafPending, 0);
assert.equal(hooked.stats.finalizerPending, 1);
assert.equal(hooked.delivered(), 1105);

// Mount the installed animated-style hook with Home's actual transformed
// updater. Native property application and shared storage remain boundaries.
let styleExpression;
function findStyle(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(homeAst) === 'homeSwipeBodyStyle')
    styleExpression = node.initializer.getText(homeAst);
  ts.forEachChild(node, findStyle);
}
findStyle(home.body);
assert.ok(styleExpression, 'Actual Home owns its animated body style');
const styleBuilt = babel.transformSync('module.exports=(useAnimatedStyle,homeSwipeOffset)=>(' + styleExpression + ');', {
  filename: homeFile, configFile: false, babelrc: false,
  presets: [[req.resolve('@babel/preset-typescript'), { allExtensions: true, isTSX: true }]],
  plugins: [req.resolve('react-native-worklets/plugin')],
}).code;
const styled = createRuntime();
const appliedStyles = [];
const styleUtils = styled.evaluate('styleUtils', (id) => assert.fail(id));
const styleHook = styled.evaluate('style', (id) => {
  if (id === 'react') return { useRef: (current) => ({ current }), useEffect: (effect) => styled.effects.push(effect) };
  if (id === 'react-native-worklets') return { isWorkletFunction: (work) => typeof work.__workletHash === 'number', makeShareable: (value) => value };
  if (id === '../animation') return { initialUpdaterRun: (updater) => updater() };
  if (id === '../common') return { IS_JEST: false, SHOULD_BE_USE_WEB: false };
  if (id === '../core') return styled.core;
  if (id === '../updateProps') return { updateProps: (_, props) => appliedStyles.push(props) };
  if (id === '../ViewDescriptorsSet') return { makeViewDescriptorsSet: () => ({ shareableViewDescriptors: sharedValue([]) }) };
  if (id === './useSharedValue') return { useSharedValue: sharedValue };
  if (id === './utils') return styleUtils;
  assert.fail('Unexpected installed style dependency: ' + id);
}).useAnimatedStyle;
const styleFactory = { exports: {} };
vm.runInContext('(function(module) {' + styleBuilt + '\n})', styled.context)(styleFactory);
const translation = sharedValue(0);
const bodyStyle = styleFactory.exports(styleHook, translation);
assert.equal(bodyStyle.initial.value.transform[0].translateX, 0, 'First paint has no off-screen transform');
assert.equal(styled.effects.length, 2, 'Installed style hook owns mapper and animation-liveness effects');
const styleCleanups = styled.effects.map((effect) => effect());
styled.drainUI(); styled.flush(1);
assert.equal(translation.listeners.size, 1);
translation.value = -12;
styled.flush(1);
assert.equal(appliedStyles.at(-1).transform[0].translateX, -12, 'Shared translation updates native styles without an RN render');
const styleRequests = styled.stats.rafRequested;
styled.emit(1000); styled.flush(100);
assert.equal(styled.stats.rafRequested, styleRequests, 'Animated style adds no idle retry chain');
styleCleanups.forEach((cleanup) => cleanup?.()); styled.drainUI();
assert.equal(translation.listeners.size, 0, 'Installed animated-style cleanup removes its mapper');

// Exercise the installed numeric timing/value-setter RAF path. Animation
// decoration/serialization is a boundary; Home's motion policy is checked above.
const easing = styled.evaluate('easing', (id) => {
  assert.equal(id, './Bezier'); return { Bezier: () => assert.fail('Unused Bezier easing') };
}).Easing;
const timing = styled.evaluate('timing', (id) => {
  if (id === '../Easing') return { Easing: easing };
  assert.equal(id, './util');
  return { defineAnimation: (_, factory) => factory(), getReduceMotionForAnimation: () => false };
}).withTiming;
const setter = styled.evaluate('valueSetter', (id) => assert.fail(id)).valueSetter;
styled.context._getAnimationTimestamp = styled.context.performance.now;
let numeric = 24;
const animated = { _animation: null };
Object.defineProperties(animated, {
  _value: { get: () => numeric, set: (value) => { numeric = value; } },
  value: { get: () => numeric, set: (value) => setter(animated, value) },
});
animated.value = timing(0, { duration: 170 });
styled.flush(20);
assert.equal(animated.value, 0, 'Actual timing reaches the target in a finite number of UI frames');
assert.equal(styled.stats.rafPending, 0);
animated.value = 24;
animated.value = timing(0, { duration: 170 });
styled.flush(1);
const canceledAt = animated.value;
animated.value = animated.value; // Exact cancelAnimation native setter contract.
styled.flush(20);
assert.equal(animated.value, canceledAt, 'Canceled animation cannot resume on a later frame');
assert.equal(styled.stats.rafPending, 0, 'Timing and cancellation leave no recurring animation callback');

console.log(JSON.stringify({ allPassed: true, hostOnly: true,
  installed: { reanimated: req('react-native-reanimated/package.json').version,
    worklets: req('react-native-worklets/package.json').version },
  sourceSha256: { ...hashes, 'app/index.tsx': sha(fs.readFileSync(homeFile)) },
  noMapper, actualStartMapper: control.stats, actualHomeReaction: hooked.stats,
  actualAnimatedStyleAndTiming: styled.stats,
  boundaryStubs: ['React effect lifecycle', 'shared-value native storage/listeners', 'native RAF dispatch',
    'scheduleOnUI task delivery', 'createSerializable identity', 'native event registration', 'microtask bridge',
    'native style application/descriptors', 'numeric animation decoration/serialization'],
  limitation: 'Host algorithm/closure/lifecycle proof; not Hermes/JNI transfer, Android scheduling or performance timing.' }, null, 2));
