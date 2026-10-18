// Host-only: transform the actual Home recognizer factory with installed
// Worklets0.10, then register its callbacks on the actual RNGH2.32 Pan class.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const crypto = require('node:crypto');
const mobile = path.resolve(__dirname, '../..');
const req = Module.createRequire(path.join(mobile, 'package.json'));
const ts = req('typescript');
const babel = req('@babel/core');
const filename = path.join(mobile, 'app/index.tsx');
const source = fs.readFileSync(filename, 'utf8');
const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let expression;
let nativeEventExpression;
const nativeWrapperExpressions = {};
function walk(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'homeSwipe')
    expression = node.initializer.arguments[0].body.getText(ast);
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'homeNativeGestureEvent')
    nativeEventExpression = node.initializer.getText(ast);
  if (ts.isVariableDeclaration(node) && ['HomeNativeScrollView', 'HomeNativeRefreshControl'].includes(node.name.getText(ast)))
    nativeWrapperExpressions[node.name.getText(ast)] = node.initializer.getText(ast);
  ts.forEachChild(node, walk);
}
walk(ast);
assert.ok(expression, 'Expected actual Home recognizer factory');
const program = 'module.exports=(Gesture,Platform,homeSwipeBlocked,homeSwipeUILease,homeSwipeStroke,homeSwipePanRef,completeHomeSwipe,scheduleOnRN,homeSwipeOffset,cancelAnimation,withTiming,ReduceMotion)=>(' + expression + ');';
const built = babel.transformSync(program, {
  filename, configFile: false, babelrc: false,
  presets: [[req.resolve('@babel/preset-typescript'), { allExtensions: true, isTSX: true }]],
  plugins: [req.resolve('react-native-worklets/plugin')],
}).code;
function evaluateTs(relative, requireModule) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(mobile, 'node_modules/react-native-gesture-handler/src/handlers/gestures', relative), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, require: requireModule });
  return module.exports;
}
const base = evaluateTs('gesture.ts', (id) => {
  if (id === '../getNextHandlerTag') return { getNextHandlerTag: () => 1 };
  if (id === '../../utils') return { isRemoteDebuggingEnabled: () => false };
  assert.fail('Unexpected actual gesture dependency: ' + id);
});
const actual = evaluateTs('panGesture.ts', (id) => {
  assert.equal(id, './gesture'); return base;
});
const moduleFactory = { exports: {} };
vm.runInNewContext(built, { module: moduleFactory, exports: moduleFactory.exports, global: { Error }, performance: { now: () => 0 } });
const uiLease = { value: { epoch: 1, from: 'collect', scope: 'one', blocked: false, reducedMotion: false } };
const offset = { value: 0 };
let rnCalls = 0;
const scheduledCommits = [];
const pan = moduleFactory.exports({ Pan: () => new actual.PanGesture() }, { OS: 'android' }, false,
  uiLease, { value: { epoch: -1, from: 'collect', startedAt: 0, x: 0, y: 0, activated: false, blocked: true, commitRequested: false } }, { current: undefined }, () => {}, (_, ...args) => { rnCalls++; scheduledCommits.push(args); },
  offset, () => {}, (target) => target, { System: 'system' });
pan.initialize();
assert.equal(pan.config.ref.current, pan, 'The actual Pan ref exposes its handlerTag for scroll/refresh relations');
assert.equal(pan.config.ref.current.handlerTag, 1);
assert.deepEqual([pan.config.activeOffsetXStart, pan.config.activeOffsetXEnd], [-12, 12]);
assert.deepEqual([pan.config.failOffsetYStart, pan.config.failOffsetYEnd], [-12, 12]);
for (const name of ['onTouchesDown', 'onTouchesMove', 'onStart', 'onUpdate', 'onEnd', 'onFinalize'])
  assert.equal(typeof pan.handlers[name].__workletHash, 'number', name + ' is a transformed UI worklet');
assert.equal(pan.handlers.onChange, undefined);
assert.equal(pan.handlers.isWorklet.filter((value) => value !== undefined).length, 6);
assert.equal(pan.shouldUseReanimated, true, 'Actual installed RNGH must choose its UI-thread handler');
assert.equal(pan.handlers.onTouchesDown.__closure.homeSwipeUILease, uiLease,
  'The DOWN worklet captures the stable atomic UI lease');
assert.equal(Object.hasOwn(pan.handlers.onTouchesDown.__closure, 'direction'), false,
  'The DOWN worklet must not retain an obsolete direction closure');
pan.handlers.onTouchesDown({ numberOfTouches: 1, allTouches: [{ absoluteX: 300, absoluteY: 300 }] }, { fail: () => assert.fail('Valid down') });
pan.handlers.onStart();
for (const [absoluteX, absoluteY, expected] of [[200, 300, -12], [0, 300, -24], [400, 300, 0], [200, 350, 0]]) {
  pan.handlers.onUpdate({ absoluteX, absoluteY });
  assert.equal(offset.value, expected, 'Actual UI preview is bounded, directional and rejects diagonal movement');
}
uiLease.value = { ...uiLease.value, reducedMotion: true };
pan.handlers.onUpdate({ absoluteX: 200, absoluteY: 300 });
assert.equal(offset.value, 0, 'Live reduced motion disables drag preview');
uiLease.value = { ...uiLease.value, reducedMotion: false, epoch: 2 };
pan.handlers.onUpdate({ absoluteX: 200, absoluteY: 300 });
assert.equal(offset.value, 0, 'An invalidated stroke cannot move the body');
assert.equal(rnCalls, 0, 'Repeated UI preview updates never schedule RN work');

// Execute the actual transformed end callback, including Android's absolute
// displacement path, rather than duplicating the threshold expression here.
function finishStroke(from, dx, velocityX, expected, options = {}) {
  uiLease.value = { ...uiLease.value, epoch: uiLease.value.epoch + 1, from,
    blocked: false, reducedMotion: false };
  const epoch = uiLease.value.epoch;
  const manager = { fail: () => assert.fail('Valid down cannot fail') };
  const before = rnCalls;
  pan.handlers.onTouchesDown({ numberOfTouches: 1, allTouches: [{ absoluteX: 300, absoluteY: 300 }] }, manager);
  pan.handlers.onStart();
  if (options.stale) uiLease.value = { ...uiLease.value, epoch: epoch + 1 };
  if (options.blocked) uiLease.value = { ...uiLease.value, blocked: true };
  const end = { absoluteX: 300 + dx, absoluteY: 300 + (options.dy ?? 0),
    translationX: 0, velocityX, numberOfPointers: 1 };
  pan.handlers.onUpdate(end);
  assert.equal(rnCalls, before, 'Gentle/flick preview remains entirely on UI');
  pan.handlers.onEnd(end, true);
  pan.handlers.onFinalize();
  assert.equal(rnCalls - before, expected ? 1 : 0,
    `${from}: dx=${dx}, velocity=${velocityX} commits exactly when eligible`);
  if (expected) assert.deepEqual(scheduledCommits.at(-1),
    [epoch, from, from === 'collect' ? 'pay' : 'collect']);
}
for (const [from, sign] of [['collect', -1], ['pay', 1]]) {
  finishStroke(from, sign * 32, 0, true);
  finishStroke(from, sign * 18, sign * 450, true);
  for (const distance of [16, 17]) finishStroke(from, sign * distance, sign * 10_000, false);
  finishStroke(from, sign * 31, 0, false);
  finishStroke(from, sign * 18, -sign * 450, false);
  for (const velocity of [NaN, Infinity, -Infinity, undefined])
    finishStroke(from, sign * 18, velocity, false);
  finishStroke(from, sign * 18, sign * 450, false, { dy: 10 });
  finishStroke(from, sign * 32, sign * 450, false, { dy: 25 });
  finishStroke(from, sign * 32, sign * 450, false, { stale: true });
  finishStroke(from, sign * 32, sign * 450, false, { blocked: true });
  finishStroke(from, -sign * 32, -sign * 450, false);
}

// Execute the installed native wrapper -> createHandler -> INNER Animated
// registration/filter/ref chain. A marker-only holder on a plain child, or an
// Animated component outside the native wrapper, cannot pass this chain.
const installed = path.join(mobile, 'node_modules');
function readInstalled(relative) { return fs.readFileSync(path.join(installed, relative), 'utf8'); }
function parseInstalled(relative) {
  return ts.createSourceFile(relative, readInstalled(relative), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}
function findNode(tree, predicate) {
  let result;
  function visit(node) {
    if (predicate(node)) { assert.equal(result, undefined, 'Expected one installed source node'); result = node; }
    ts.forEachChild(node, visit);
  }
  visit(tree); assert.ok(result, 'Expected installed source node'); return result;
}
function runTs(code, globals = {}, requireModule = (id) => assert.fail('Unexpected installed dependency: ' + id)) {
  const module = { exports: {} };
  const output = ts.transpileModule(code, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React,
  } }).outputText;
  vm.runInNewContext(output, { module, exports: module.exports, require: requireModule, ...globals });
  return module.exports;
}
function loadInstalled(relative, requireModule) { return runTs(readInstalled(relative), {}, requireModule); }
function declaration(tree, name) {
  return findNode(tree, (n) => ts.isVariableDeclaration(n) && n.name.getText(tree) === name);
}
const registrations = new Map();
let nextRegistration = 1;
const eventModule = loadInstalled('react-native-reanimated/src/WorkletEventHandler.ts', (id) => {
  if (id === './common') return { SHOULD_BE_USE_WEB: false };
  if (id === './core') return {
    registerEventHandler: (worklet, eventName, tag) => {
      const token = nextRegistration++; registrations.set(token, { worklet, eventName, tag }); return token;
    },
    unregisterEventHandler: (token) => { assert.ok(registrations.delete(token), 'Registration must exist when detached'); },
  };
  assert.fail('Unexpected WorkletEventHandler dependency: ' + id);
});
const actualUseEvent = loadInstalled('react-native-reanimated/src/hook/useEvent.ts', (id) => {
  if (id === 'react') return { useRef: (current) => ({ current }) };
  assert.equal(id, '../WorkletEventHandler'); return eventModule;
}).useEvent;
assert.ok(nativeEventExpression, 'Expected actual Home native UI handler');
const eventBuilt = babel.transformSync('module.exports=(useEvent)=>(' + nativeEventExpression + ');', {
  filename, configFile: false, babelrc: false,
  presets: [[req.resolve('@babel/preset-typescript'), { allExtensions: true, isTSX: true }]],
  plugins: [req.resolve('react-native-worklets/plugin')],
}).code;
const eventFactory = { exports: {} };
vm.runInNewContext(eventBuilt, { module: eventFactory, exports: eventFactory.exports, global: { Error } });
const eventHolder = eventFactory.exports(actualUseEvent);
assert.ok(eventHolder.workletEventHandler instanceof eventModule.WorkletEventHandler);
assert.equal(typeof eventHolder.workletEventHandler.worklet.__workletHash, 'number', 'Native-only event sink is a real worklet');
assert.deepEqual(Array.from(eventHolder.workletEventHandler.eventNames), ['onGestureHandlerEvent', 'onGestureHandlerStateChange']);

const commonTree = parseInstalled('react-native-gesture-handler/src/handlers/gestureHandlerCommon.ts');
const nativeTree = parseInstalled('react-native-gesture-handler/src/handlers/NativeViewGestureHandler.ts');
const nativeViewProps = runTs([
  ...['commonProps', 'componentInteractionProps', 'baseGestureHandlerProps'].map((name) => 'const ' + declaration(commonTree, name).getText(commonTree) + ';'),
  ...['nativeViewGestureHandlerProps', 'nativeViewProps'].map((name) => 'const ' + declaration(nativeTree, name).getText(nativeTree) + ';'),
  'module.exports=nativeViewProps;',
].join('\n'));
let imperative;
const reactShim = {
  forwardRef: (render) => render,
  useRef: (current) => ({ current }),
  useImperativeHandle: (ref, create) => { imperative = () => { ref.current = create(); }; },
  createElement: (type, props, ...children) => ({ type, props: { ...props, ...(children.length ? { children: children.length === 1 ? children[0] : children } : {}) } }),
  cloneElement: (child, props, children) => ({ ...child, props: { ...child.props, ...props, children } }),
  Children: { only: (child) => { assert.ok(child && !Array.isArray(child)); return child; } },
};
const NativeHandler = Symbol('actual-native-handler-boundary');
const createNativeWrapper = loadInstalled('react-native-gesture-handler/src/handlers/createNativeWrapper.tsx', (id) => {
  if (id === 'react') return reactShim;
  assert.equal(id, './NativeViewGestureHandler'); return { NativeViewGestureHandler: NativeHandler, nativeViewProps };
}).default;
const handlerTree = parseInstalled('react-native-gesture-handler/src/handlers/createHandler.tsx');
const actionExpression = declaration(handlerTree, 'actionType').initializer.getText(handlerTree);
const ActionType = loadInstalled('react-native-gesture-handler/src/ActionType.ts').ActionType;
const selectAction = runTs('module.exports=function(){return ' + actionExpression + ';};', { ActionType });
const renderMethod = findNode(handlerTree, (node) => ts.isMethodDeclaration(node) && node.name.getText(handlerTree) === 'render');
const ActualHandlerRender = runTs('module.exports=class {' + renderMethod.getText(handlerTree) + '};', {
  React: reactShim, __DEV__: false, isTestEnv: () => false,
});
const refInitializer = findNode(handlerTree, (node) => ts.isPropertyDeclaration(node) && node.name.getText(handlerTree) === 'refHandler').initializer.getText(handlerTree);
const ActualHandlerRef = runTs('module.exports=class { refHandler=' + refInitializer + '; };', { React: reactShim, isReact19: () => true });
const cssTree = parseInstalled('react-native-reanimated/src/css/component/AnimatedComponent.tsx');
const animatedRefInitializer = findNode(cssTree, (node) => ts.isPropertyDeclaration(node) && node.name.getText(cssTree) === '_setComponentRef').initializer.getText(cssTree);
const ActualAnimatedRef = runTs('module.exports=class { _setComponentRef=' + animatedRefInitializer + '; };');
const utils = loadInstalled('react-native-reanimated/src/createAnimatedComponent/utils.ts');
const managers = loadInstalled('react-native-reanimated/src/createAnimatedComponent/NativeEventsManager.ts', (id) => {
  if (id === '../platformFunctions/findNodeHandle') return { findNodeHandle: (node) => typeof node === 'number' ? node : node.tag };
  if (id === '../WorkletEventHandler') return eventModule;
  assert.equal(id, './utils'); return utils;
});
const filterModule = loadInstalled('react-native-reanimated/src/createAnimatedComponent/PropsFilter.tsx', (id) => {
  if (id === '../WorkletEventHandler') return eventModule;
  if (id === './utils') return utils;
  if (id === '../animation') return { initialUpdaterRun: (worklet) => worklet() };
  if (id === '../css/utils') return { isCSSConfigProp: () => false };
  if (id === '../isSharedValue') return { isSharedValue: () => false };
  if (id === './InlinePropManager') return { hasInlineStyles: () => false };
  assert.fail('Unexpected PropsFilter dependency: ' + id);
});
const AnimatedScroll = Symbol('inner-animated-scroll');
const AnimatedRefresh = Symbol('inner-animated-refresh');
const coreRefresh = Symbol('core-refresh');
const Reanimated = {
  ScrollView: AnimatedScroll,
  createAnimatedComponent: (component) => { assert.equal(component, coreRefresh); return AnimatedRefresh; },
};
const wrappers = runTs('module.exports={' + Object.entries(nativeWrapperExpressions).map(([name, value]) => name + ':' + value).join(',') + '};', {
  createNativeWrapper, Reanimated, RefreshControl: coreRefresh,
});
const panRef = { current: pan };
const refreshRef = { current: null };
function mountWrapper(wrapper, animatedType, hostTag, forwardedRef, extraProps = {}) {
  const nativeElement = wrapper({ onGestureEvent: eventHolder, simultaneousHandlers: panRef, ...extraProps }, forwardedRef);
  const finishImperativeRef = imperative;
  assert.equal(nativeElement.type, NativeHandler);
  assert.equal(nativeElement.props.children.type, animatedType, 'Animated must be INSIDE the native wrapper');
  assert.equal(nativeElement.props.onGestureEvent, eventHolder, 'Native handler receives useEvent holder before PropsFilter');
  assert.equal(nativeElement.props.disallowInterruption, false);
  assert.equal(nativeElement.props.shouldActivateOnStart, false);
  assert.equal(nativeElement.props.shouldCancelWhenOutside, false);
  assert.equal(nativeElement.props.simultaneousHandlers.current, pan);
  assert.equal(selectAction.call({ props: nativeElement.props }), ActionType.REANIMATED_WORKLET,
    'Installed createHandler must route native motion directly to Reanimated');
  assert.equal(selectAction.call({ props: { onGestureEvent: () => {} } }), ActionType.JS_FUNCTION_OLD_API,
    'Control: plain callback is the unwanted RN route');
  const handler = new ActualHandlerRender();
  handler.props = nativeElement.props; handler.state = { allowTouches: true }; handler.propsRef = { current: null };
  handler.onGestureHandlerEvent = () => assert.fail('Unexpected RN gesture callback');
  handler.onGestureHandlerStateChange = () => assert.fail('Unexpected RN state callback');
  const refHandler = new ActualHandlerRef(); refHandler.props = nativeElement.props;
  handler.refHandler = refHandler.refHandler;
  const animatedElement = handler.render();
  assert.equal(animatedElement.props.onGestureHandlerEvent, eventHolder, 'Actual createHandler forwards holder to inner Animated child');
  const filtered = new filterModule.PropsFilter().filterNonAnimatedProps({ props: animatedElement.props, _isFirstRender: true });
  assert.equal(typeof filtered.onGestureHandlerEvent, 'function', 'INNER Animated filters holder before native host props');
  assert.notEqual(filtered.onGestureHandlerEvent, eventHolder);
  assert.equal(typeof filtered.onGestureHandlerStateChange, 'function');
  const scrollTo = () => {};
  const host = { tag: hostTag, scrollTo, ...(animatedType === AnimatedScroll ? { getScrollableNode: () => hostTag } : {}) };
  const animatedRef = new ActualAnimatedRef();
  animatedRef.props = { forwardedRef: animatedElement.props.ref };
  animatedRef._resolveComponentRef = (node) => node; animatedRef._onSetLocalRef = () => {};
  animatedRef._setComponentRef(host);
  assert.equal(refHandler.viewNode, host, 'Animated forwards the real host to actual native-handler ref callback');
  nativeElement.props.ref.current = { handlerTag: hostTag + 1000 };
  finishImperativeRef();
  assert.equal(forwardedRef.current, host, 'Actual createNativeWrapper returns original host');
  assert.equal(forwardedRef.current.scrollTo, scrollTo, 'Existing scroll command stays intact');
  assert.equal(forwardedRef.current.handlerTag, hostTag + 1000, 'Native handler tag survives for waitFor/simultaneous refs');
  const manager = new managers.NativeEventsManager({
    props: animatedElement.props, _componentRef: host,
    // Scroll must select getScrollableNode instead of this outer refresh tag.
    getComponentViewTag: () => animatedType === AnimatedScroll ? 9999 : hostTag,
  });
  manager.attachEvents();
  return { manager, nativeElement };
}
const refresh = mountWrapper(wrappers.HomeNativeRefreshControl, AnimatedRefresh, 202, refreshRef);
const scrollRef = { current: null };
const scroll = mountWrapper(wrappers.HomeNativeScrollView, AnimatedScroll, 101, scrollRef, { waitFor: refreshRef });
assert.equal(scroll.nativeElement.props.waitFor.current.handlerTag, 1202, 'Scroll waitFor resolves actual refresh handler');
assert.equal(registrations.size, 4, 'Same holder registers both event names on both distinct hosts');
for (const tag of [101, 202]) {
  const events = [...registrations.values()].filter((registration) => registration.tag === tag);
  assert.deepEqual(events.map((event) => event.eventName).sort(), ['onGestureHandlerEvent', 'onGestureHandlerStateChange'].sort());
  assert.ok(events.every((event) => event.worklet === eventHolder.workletEventHandler.worklet));
}
scroll.manager.detachEvents();
assert.equal(registrations.size, 2, 'Unmounting scroll preserves refresh registrations');
assert.ok([...registrations.values()].every((registration) => registration.tag === 202));
refresh.manager.detachEvents();
assert.equal(registrations.size, 0, 'Unmount cleans every registration');
console.log(JSON.stringify({ allPassed: true, actualSourceFactory: true, actualInstalledPan: true,
  callbacks: 6, shouldUseReanimated: true, perMoveRNCallbacks: 0,
  actualNativeActionRoute: 'REANIMATED_WORKLET', actualInnerAnimatedRegistration: true,
  nativeHosts: 2, nativeEventRegistrations: 4, cleanupIndependent: true, actualHostRefPreserved: true,
  sourceSha256: crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex') }));
