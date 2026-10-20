'use strict';

/**
 * Alert Storm Guard Module (Pluggable Zero-Dependency Module)
 * 
 * Provides 3 layers of alert suppression:
 * 1. Explicit Parent ID hierarchy (with cycle detection & cascade root cause)
 * 2. Topology Map dependency with Role Weight priorities & Dual-Homing
 * 3. Burst / Mass Outage aggregation when >= threshold devices fail simultaneously
 * 
 * Fail-Open Design:
 * If disabled (storm_guard_enabled == 0) or on any exception,
 * returns { suppressed: false, rootCause: null, burstGroup: false }.
 */

const ROLE_WEIGHT = {
  firewall: 1,
  router: 1,
  gateway: 1,
  switch: 2,
  server: 3,
  vm: 3,
  ap: 3,
  printer: 3,
  pc: 3,
  ups: 3,
  other: 3,
};

function getRoleWeight(type) {
  const t = String(type || '').trim().toLowerCase();
  return ROLE_WEIGHT[t] ?? 3;
}

function toDeviceMap(allDevices) {
  if (allDevices instanceof Map) return allDevices;
  const map = new Map();
  if (Array.isArray(allDevices)) {
    for (const d of allDevices) {
      if (d && d.id != null) map.set(d.id, d);
    }
  } else if (allDevices && typeof allDevices === 'object') {
    for (const [k, v] of Object.entries(allDevices)) {
      const id = Number(k) || k;
      map.set(id, { id, ...v });
    }
  }
  return map;
}

function isDeviceOffline(dev, stateMap) {
  if (!dev) return false;
  let status = dev.status;
  if (!status && stateMap) {
    const st = stateMap.get ? stateMap.get(dev.id) : stateMap[dev.id];
    if (st) status = st.status;
  }
  return status === 'down' || status === 'offline';
}

function normalizeTopologyLinks(topologyLinks) {
  if (!topologyLinks) return [];
  // If it's a map data object { nodes, links }
  if (typeof topologyLinks === 'object' && !Array.isArray(topologyLinks) && Array.isArray(topologyLinks.links)) {
    const nodeToDev = new Map();
    if (Array.isArray(topologyLinks.nodes)) {
      for (const n of topologyLinks.nodes) {
        if (n && n.kind === 'device' && n.ref != null) {
          nodeToDev.set(n.id, n.ref);
        } else if (n && n.id != null) {
          nodeToDev.set(n.id, n.id);
        }
      }
    }
    const result = [];
    for (const link of topologyLinks.links) {
      if (!link || !link.from || !link.to) continue;
      const devA = nodeToDev.get(link.from) ?? link.from;
      const devB = nodeToDev.get(link.to) ?? link.to;
      if (devA != null && devB != null && devA !== devB) {
        result.push({ from: devA, to: devB });
      }
    }
    return result;
  }

  // If it's already an array of links
  if (Array.isArray(topologyLinks)) {
    return topologyLinks.map((l) => {
      if (!l) return null;
      return { from: l.from, to: l.to };
    }).filter(Boolean);
  }

  return [];
}

/**
 * Traces upstream via parent_id recursively to find the root cause offline device.
 * Uses Set() for cycle detection to prevent infinite loops.
 */
function findParentIdRootCause(targetDev, devMap, stateMap, visited = new Set()) {
  if (!targetDev || targetDev.parent_id == null || targetDev.parent_id === targetDev.id) return null;
  if (visited.has(targetDev.id)) return null; // Cycle detected
  visited.add(targetDev.id);

  const parentDev = devMap.get(targetDev.parent_id);
  if (!parentDev) return null;
  if (!isDeviceOffline(parentDev, stateMap)) return null;

  // Parent is offline! Trace higher upstream to find the ultimate root cause
  const higherRoot = findParentIdRootCause(parentDev, devMap, stateMap, visited);
  return higherRoot || parentDev;
}

/**
 * Finds direct upstream parents from topology links based on Role Weight.
 * Role Weight: firewall/router (1) > switch (2) > server/ap/printer (3)
 */
function getTopologyParents(targetDev, devMap, normLinks) {
  if (!targetDev || !targetDev.id) return [];
  const parents = [];
  const targetWeight = getRoleWeight(targetDev.type);

  for (const link of normLinks) {
    let otherId = null;
    let isFromOther = false;

    if (link.from === targetDev.id) {
      otherId = link.to;
      isFromOther = false;
    } else if (link.to === targetDev.id) {
      otherId = link.from;
      isFromOther = true;
    } else {
      continue;
    }

    const otherDev = devMap.get(otherId);
    if (!otherDev) continue;

    const otherWeight = getRoleWeight(otherDev.type);

    // If other has strictly higher priority (lower weight number), other is Parent
    if (otherWeight < targetWeight) {
      parents.push(otherDev);
    } else if (targetWeight < otherWeight) {
      // Target is parent of other -> not an upstream parent
      continue;
    } else {
      // Same weight: link direction from -> to defines parent -> child
      if (isFromOther) {
        parents.push(otherDev);
      }
    }
  }

  // Deduplicate parents by ID
  const uniqueParents = [];
  const seen = new Set();
  for (const p of parents) {
    if (!seen.has(p.id)) {
      seen.add(p.id);
      uniqueParents.push(p);
    }
  }
  return uniqueParents;
}

/**
 * Traces topology upstream to find the root cause device.
 */
function findTopologyRootCause(dev, devMap, normLinks, stateMap, visited = new Set()) {
  if (!dev || !dev.id || visited.has(dev.id)) return null;
  visited.add(dev.id);

  const parents = getTopologyParents(dev, devMap, normLinks);
  if (!parents.length) return dev;

  const allOffline = parents.every((p) => isDeviceOffline(p, stateMap));
  if (!allOffline) return dev;

  for (const p of parents) {
    const root = findTopologyRootCause(p, devMap, normLinks, stateMap, visited);
    if (root) return root;
  }
  return parents[0];
}

/**
 * Checks if a device is suppressed by Parent ID or Topology (without burst check).
 */
function checkIsSuppressed(dev, devMap, normLinks, stateMap, useParentId, useTopology) {
  if (useParentId && dev.parent_id != null && dev.parent_id !== dev.id) {
    const root = findParentIdRootCause(dev, devMap, stateMap);
    if (root) return { suppressed: true, rootCause: root };
  }
  if (useTopology && (dev.parent_id == null || !useParentId)) {
    const parents = getTopologyParents(dev, devMap, normLinks);
    if (parents.length > 0) {
      const allDown = parents.every((p) => isDeviceOffline(p, stateMap));
      if (allDown) {
        const root = findTopologyRootCause(parents[0], devMap, normLinks, stateMap, new Set([dev.id])) || parents[0];
        return { suppressed: true, rootCause: root };
      }
    }
  }
  return { suppressed: false, rootCause: null };
}

/**
 * Main Storm Guard Evaluator
 * 
 * @param {object|number} device - Device being evaluated (or device ID)
 * @param {Map|Array|object} allDevices - All devices map or array
 * @param {Array|object} topologyLinks - Topology links or map data
 * @param {object} settings - Settings object
 * @param {Map|object} [stateMap] - Optional state map with device statuses
 * @returns {{ suppressed: boolean, rootCause: object|null, burstGroup: boolean, burstCount?: number }}
 */
function evaluateStormGuard(device, allDevices, topologyLinks, settings, stateMap) {
  try {
    const s = settings || {};
    const enabled = Boolean(
      s.storm_guard_enabled === 1 ||
      s.storm_guard_enabled === true ||
      s.storm_guard_enabled === '1' ||
      (s.storm_guard && (s.storm_guard.enabled === 1 || s.storm_guard.enabled === true))
    );

    // Fail-open: When disabled, return immediately without touching anything
    if (!enabled) {
      return { suppressed: false, rootCause: null, burstGroup: false };
    }

    const devMap = toDeviceMap(allDevices);
    const targetDev = (typeof device === 'object' && device !== null)
      ? (devMap.get(device.id) || device)
      : devMap.get(device);

    if (!targetDev) {
      return { suppressed: false, rootCause: null, burstGroup: false };
    }

    const useParentId = Number(
      s.storm_use_parent_id ??
      (s.storm_guard && s.storm_guard.use_parent_id) ??
      1
    ) === 1;

    const useTopology = Number(
      s.storm_use_topology ??
      (s.storm_guard && s.storm_guard.use_topology) ??
      0
    ) === 1;

    const burstThreshold = Number(
      s.storm_burst_threshold ??
      (s.storm_guard && s.storm_guard.burst_threshold) ??
      3
    );

    const normLinks = normalizeTopologyLinks(topologyLinks);

    // Layer 1: Parent ID
    if (useParentId && targetDev.parent_id != null && targetDev.parent_id !== targetDev.id) {
      const rootCause = findParentIdRootCause(targetDev, devMap, stateMap);
      if (rootCause) {
        return { suppressed: true, rootCause, burstGroup: false };
      }
    }

    // Layer 2: Topology Map
    if (useTopology && (targetDev.parent_id == null || !useParentId)) {
      const parents = getTopologyParents(targetDev, devMap, normLinks);
      if (parents.length > 0) {
        const allParentsDown = parents.every((p) => isDeviceOffline(p, stateMap));
        if (allParentsDown) {
          const rootCause = findTopologyRootCause(parents[0], devMap, normLinks, stateMap, new Set([targetDev.id])) || parents[0];
          return { suppressed: true, rootCause, burstGroup: false };
        }
      }
    }

    // Layer 3: Burst / Mass Outage Aggregator
    if (burstThreshold > 0) {
      let unsuppressedOfflineCount = 0;
      for (const d of devMap.values()) {
        if (isDeviceOffline(d, stateMap)) {
          const check = checkIsSuppressed(d, devMap, normLinks, stateMap, useParentId, useTopology);
          if (!check.suppressed) {
            unsuppressedOfflineCount++;
          }
        }
      }

      if (unsuppressedOfflineCount >= burstThreshold) {
        return {
          suppressed: false,
          rootCause: null,
          burstGroup: true,
          burstCount: unsuppressedOfflineCount,
        };
      }
    }

    return { suppressed: false, rootCause: null, burstGroup: false };
  } catch (_err) {
    // Fail-open safety on any unexpected exception
    return { suppressed: false, rootCause: null, burstGroup: false };
  }
}

module.exports = {
  evaluateStormGuard,
  getRoleWeight,
  isDeviceOffline,
  findParentIdRootCause,
  getTopologyParents,
  findTopologyRootCause,
  normalizeTopologyLinks,
  ROLE_WEIGHT,
};
