'use strict';

/**
 * Automated Verification Suite for Alert Storm Guard Module
 * 
 * Verifies all 6 mandatory test cases:
 * - Case 1 (Master Switch OFF): Fail-open original behavior (suppressed: false)
 * - Case 2 (Parent ID Cascade): Core -> Access -> AP root cause resolution
 * - Case 3 (Circular Loop Detection): A -> B -> A resolved in < 5ms without hanging
 * - Case 4 (Topology Reverse-Drawn Links): Role Weight priority (Switch vs AP)
 * - Case 5 (Dual-Homing Redundant Uplinks): Suppress ONLY when ALL parents are offline
 * - Case 6 (Burst Threshold / Mass Outage): Group flag triggered for >= N simultaneous drops
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { evaluateStormGuard } = require('../server/storm-guard');

test('Case 1 (Master Switch OFF): When storm_guard_enabled = 0, all devices return suppressed: false', () => {
  const disabledSettings = {
    storm_guard_enabled: 0,
    storm_use_parent_id: 1,
    storm_use_topology: 1,
    storm_burst_threshold: 3,
  };

  const coreSwitch = { id: 1, name: 'Core-Switch', type: 'switch', status: 'down', parent_id: null };
  const accessSwitch = { id: 2, name: 'Access-Switch', type: 'switch', status: 'down', parent_id: 1 };
  const ap = { id: 3, name: 'AP-Floor-1', type: 'ap', status: 'down', parent_id: 2 };
  const allDevices = [coreSwitch, accessSwitch, ap];
  const topoLinks = [{ from: 1, to: 2 }, { from: 2, to: 3 }];

  // Even though upstream parent is down, storm guard is OFF -> MUST return suppressed: false
  const resCore = evaluateStormGuard(coreSwitch, allDevices, topoLinks, disabledSettings);
  assert.equal(resCore.suppressed, false, 'Core switch must not be suppressed when disabled');
  assert.equal(resCore.burstGroup, false);

  const resAccess = evaluateStormGuard(accessSwitch, allDevices, topoLinks, disabledSettings);
  assert.equal(resAccess.suppressed, false, 'Access switch must not be suppressed when disabled');
  assert.equal(resAccess.burstGroup, false);

  const resAp = evaluateStormGuard(ap, allDevices, topoLinks, disabledSettings);
  assert.equal(resAp.suppressed, false, 'AP must not be suppressed when disabled');
  assert.equal(resAp.burstGroup, false);

  // Even with 10 devices down simultaneously, disabled guard must NOT group or suppress
  const tenDownDevices = Array.from({ length: 10 }, (_, i) => ({
    id: 100 + i,
    name: `Device-${i}`,
    type: 'server',
    status: 'down',
  }));
  const resTen = evaluateStormGuard(tenDownDevices[0], tenDownDevices, [], disabledSettings);
  assert.equal(resTen.suppressed, false);
  assert.equal(resTen.burstGroup, false);
});

test('Case 2 (Parent ID Cascade): Switch Core (Down) -> Switch Access (Down) -> AP (Down)', () => {
  const enabledSettings = {
    storm_guard_enabled: 1,
    storm_use_parent_id: 1,
    storm_use_topology: 0,
    storm_burst_threshold: 0, // isolate parent_id test
  };

  const coreSwitch = { id: 1, name: 'Switch Core', type: 'switch', status: 'down', parent_id: null };
  const accessSwitch = { id: 2, name: 'Switch Access', type: 'switch', status: 'down', parent_id: 1 };
  const ap = { id: 3, name: 'AP Office', type: 'ap', status: 'down', parent_id: 2 };
  const allDevices = [coreSwitch, accessSwitch, ap];

  // 1. Switch Core has no parent -> root alarm, MUST NOT be suppressed
  const resCore = evaluateStormGuard(coreSwitch, allDevices, [], enabledSettings);
  assert.equal(resCore.suppressed, false, 'Switch Core must be the root alarm (suppressed: false)');

  // 2. Switch Access has parent Switch Core (offline) -> MUST be suppressed, rootCause is Switch Core
  const resAccess = evaluateStormGuard(accessSwitch, allDevices, [], enabledSettings);
  assert.equal(resAccess.suppressed, true, 'Switch Access must be suppressed');
  assert.ok(resAccess.rootCause, 'Switch Access must have a rootCause');
  assert.equal(resAccess.rootCause.id, 1, 'Root cause for Switch Access must point to Switch Core');
  assert.equal(resAccess.rootCause.name, 'Switch Core');

  // 3. AP has parent Switch Access (offline) -> MUST be suppressed, cascading rootCause points to Switch Core
  const resAp = evaluateStormGuard(ap, allDevices, [], enabledSettings);
  assert.equal(resAp.suppressed, true, 'AP must be suppressed');
  assert.ok(resAp.rootCause, 'AP must have a rootCause');
  assert.equal(resAp.rootCause.id, 1, 'Cascading root cause for AP must point to Switch Core');
  assert.equal(resAp.rootCause.name, 'Switch Core');
});

test('Case 3 (Chống lặp vòng tròn - Circular Loop): A -> B -> A resolved in under 5ms without hanging', () => {
  const enabledSettings = {
    storm_guard_enabled: 1,
    storm_use_parent_id: 1,
    storm_use_topology: 1,
    storm_burst_threshold: 0,
  };

  // Device A points parent_id to B, and B points parent_id to A
  const devA = { id: 10, name: 'Device-A', type: 'switch', status: 'down', parent_id: 11 };
  const devB = { id: 11, name: 'Device-B', type: 'switch', status: 'down', parent_id: 10 };
  const allDevices = [devA, devB];

  const t0 = performance.now();
  const resA = evaluateStormGuard(devA, allDevices, [], enabledSettings);
  const resB = evaluateStormGuard(devB, allDevices, [], enabledSettings);
  const elapsedMs = performance.now() - t0;

  assert.ok(elapsedMs < 5.0, `Circular loop check must complete in under 5ms (took ${elapsedMs.toFixed(3)}ms)`);
  // Must safely resolve without throw and without infinite recursion
  assert.ok(resA !== undefined && resB !== undefined);
  assert.equal(typeof resA.suppressed, 'boolean');
  assert.equal(typeof resB.suppressed, 'boolean');

  // Also test circular loop on Topology: X -> Y -> Z -> X
  const devX = { id: 21, name: 'Node-X', type: 'switch', status: 'down' };
  const devY = { id: 22, name: 'Node-Y', type: 'switch', status: 'down' };
  const devZ = { id: 23, name: 'Node-Z', type: 'switch', status: 'down' };
  const ringLinks = [
    { from: 21, to: 22 },
    { from: 22, to: 23 },
    { from: 23, to: 21 },
  ];
  const tRing0 = performance.now();
  const resX = evaluateStormGuard(devX, [devX, devY, devZ], ringLinks, { ...enabledSettings, storm_use_parent_id: 0 });
  const elapsedRingMs = performance.now() - tRing0;

  assert.ok(elapsedRingMs < 5.0, `Ring topology must resolve in under 5ms (took ${elapsedRingMs.toFixed(3)}ms)`);
  assert.equal(typeof resX.suppressed, 'boolean');
});

test('Case 4 (Topology vẽ ngược chiều): Role Weight priority handles reverse-drawn links correctly', () => {
  const enabledSettings = {
    storm_guard_enabled: 1,
    storm_use_parent_id: 0,
    storm_use_topology: 1,
    storm_burst_threshold: 0,
  };

  const switchDev = { id: 31, name: 'Floor-Switch', type: 'switch', status: 'down' };
  const apDev = { id: 32, name: 'Ceiling-AP', type: 'ap', status: 'down' };
  const allDevices = [switchDev, apDev];

  // User drew link in reverse: from AP to Switch!
  const reverseLinks = [{ from: 32, to: 31 }];

  // Role Weight: Switch (weight 2) > AP (weight 3)
  // Scenario A: Switch is DOWN, AP is DOWN
  // Since Switch is higher hierarchy than AP, AP MUST be suppressed by Switch
  const resAp = evaluateStormGuard(apDev, allDevices, reverseLinks, enabledSettings);
  assert.equal(resAp.suppressed, true, 'AP must be suppressed when higher-tier Switch fails, even if link drawn in reverse');
  assert.equal(resAp.rootCause.id, 31, 'Root cause of AP must be Switch');

  // Scenario B: Switch is DOWN, but who suppresses Switch?
  // AP cannot suppress Switch because AP has lower hierarchy (weight 3 vs 2)
  const resSwitch = evaluateStormGuard(switchDev, allDevices, reverseLinks, enabledSettings);
  assert.equal(resSwitch.suppressed, false, 'Switch must NOT be suppressed by lower-tier AP');

  // Scenario C: Switch is UP, AP is DOWN
  switchDev.status = 'up';
  const resApAlone = evaluateStormGuard(apDev, allDevices, reverseLinks, enabledSettings);
  assert.equal(resApAlone.suppressed, false, 'AP must NOT be suppressed when Switch is UP');
});

test('Case 5 (Dual-homing / Dự phòng 2 đường): Suppress ONLY when ALL redundant parents are offline', () => {
  const enabledSettings = {
    storm_guard_enabled: 1,
    storm_use_parent_id: 0,
    storm_use_topology: 1,
    storm_burst_threshold: 0,
  };

  const sw1 = { id: 41, name: 'Switch-Primary', type: 'switch', status: 'up' };
  const sw2 = { id: 42, name: 'Switch-Secondary', type: 'switch', status: 'up' };
  const srv = { id: 43, name: 'Dual-Homed-Database', type: 'server', status: 'down' };
  const allDevices = [sw1, sw2, srv];

  // Server is connected to both Switch-Primary and Switch-Secondary
  const dualLinks = [
    { from: 41, to: 43 },
    { from: 42, to: 43 },
  ];

  // Subcase 5A: Only Switch 1 is DOWN, but Switch 2 is UP
  // Server is DOWN. Since Switch 2 is still UP, the server outage could be an independent failure!
  sw1.status = 'down';
  sw2.status = 'up';
  const res5A = evaluateStormGuard(srv, allDevices, dualLinks, enabledSettings);
  assert.equal(res5A.suppressed, false, 'Server must NOT be suppressed when one redundant uplink is still UP');

  // Subcase 5B: BOTH Switch 1 and Switch 2 are DOWN
  // All upstream paths are dead -> Server MUST be suppressed!
  sw2.status = 'down';
  const res5B = evaluateStormGuard(srv, allDevices, dualLinks, enabledSettings);
  assert.equal(res5B.suppressed, true, 'Server MUST be suppressed when ALL redundant parents are offline');
  assert.ok(res5B.rootCause);
});

test('Case 6 (Burst Threshold): 4 devices down simultaneously triggers Mass Outage burst group flag', () => {
  const enabledSettings = {
    storm_guard_enabled: 1,
    storm_use_parent_id: 1,
    storm_use_topology: 1,
    storm_burst_threshold: 3, // threshold is 3
  };

  // 4 standalone devices without parent_id or topology links
  const vm1 = { id: 51, name: 'VM-App-1', type: 'server', status: 'down' };
  const vm2 = { id: 52, name: 'VM-App-2', type: 'server', status: 'down' };
  const vm3 = { id: 53, name: 'VM-App-3', type: 'server', status: 'down' };
  const vm4 = { id: 54, name: 'VM-App-4', type: 'server', status: 'down' };
  const allDevices = [vm1, vm2, vm3, vm4];

  // 4 unsuppressed devices are down >= threshold 3 -> burstGroup MUST be true!
  const resVm1 = evaluateStormGuard(vm1, allDevices, [], enabledSettings);
  assert.equal(resVm1.suppressed, false, 'Device is not suppressed by hierarchy');
  assert.equal(resVm1.burstGroup, true, 'Burst threshold met: must mark burstGroup = true');
  assert.equal(resVm1.burstCount, 4);

  // If only 2 devices were down (below threshold 3) -> burstGroup MUST be false
  vm3.status = 'up';
  vm4.status = 'up';
  const resBelowThreshold = evaluateStormGuard(vm1, allDevices, [], enabledSettings);
  assert.equal(resBelowThreshold.suppressed, false);
  assert.equal(resBelowThreshold.burstGroup, false, 'Below threshold of 3: burstGroup must be false');

  // If burst_threshold = 0 (disabled), even 4 devices down must NOT set burstGroup
  const resDisabledThreshold = evaluateStormGuard(vm1, [vm1, vm2, vm3, vm4], [], {
    ...enabledSettings,
    storm_burst_threshold: 0,
  });
  assert.equal(resDisabledThreshold.burstGroup, false, 'Threshold 0 means burst grouping is disabled');
});
