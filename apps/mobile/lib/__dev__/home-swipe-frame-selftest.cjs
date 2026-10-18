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
  return { context, stats, core, mappers, reaction, effects, flush, drainUI,
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
const source = 'module.exports=(useAnimatedReaction,homeSwipeUILease,homeSwipeStroke)=>{' + call.getText(homeAst) + ';};';
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
const lease = sharedValue({ epoch: 8, from: 'collect' });
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
}, lease, stroke);
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
lease.value = { epoch: 9, from: 'pay' };
hooked.flush(1);
assert.equal(stroke.value, alreadyBlocked, 'Already blocked stroke is not repeatedly written');
stroke.value = { epoch: 9, from: 'pay', blocked: false, activated: true };
const currentStroke = stroke.value;
lease.value = { epoch: 9, from: 'pay' };
hooked.flush(1);
assert.equal(stroke.value, currentStroke, 'Same-epoch current stroke is preserved');
lease.value = { epoch: 10, from: 'collect' };
hooked.flush(1);
assert.equal(stroke.value.blocked, true, 'Later lease invalidation cancels a fresh active stroke');
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

console.log(JSON.stringify({ allPassed: true, hostOnly: true,
  installed: { reanimated: req('react-native-reanimated/package.json').version,
    worklets: req('react-native-worklets/package.json').version },
  sourceSha256: { ...hashes, 'app/index.tsx': sha(fs.readFileSync(homeFile)) },
  noMapper, actualStartMapper: control.stats, actualHomeReaction: hooked.stats,
  boundaryStubs: ['React effect lifecycle', 'shared-value native storage/listeners', 'native RAF dispatch',
    'scheduleOnUI task delivery', 'createSerializable identity', 'native event registration', 'microtask bridge'],
  limitation: 'Host algorithm/closure/lifecycle proof; not Hermes/JNI transfer, Android scheduling or performance timing.' }, null, 2));
