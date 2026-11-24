import { beforeEach, vi } from "vitest";
import {
  addNativeListener,
  mockLocalStorage,
  mockLocationState,
  mockNativeState,
  mockSonarMeshNative,
  mockSqliteDb,
  mockSqliteState,
  resetAllBoundaryMocks,
} from "./nativeMocks";

class MockExpoEventEmitter {
  private mod?: { addListener?: (eventName: string, listener: (...args: unknown[]) => void) => { remove: () => void } };

  constructor(mod?: { addListener?: (eventName: string, listener: (...args: unknown[]) => void) => { remove: () => void } }) {
    this.mod = mod;
  }

  addListener(eventName: string, listener: (...args: unknown[]) => void) {
    if (this.mod && typeof this.mod.addListener === "function") {
      return this.mod.addListener(eventName, listener);
    }
    return addNativeListener(eventName, listener);
  }
}

// Provide globalThis.expo for expo-modules-core EventEmitter compatibility in Node
(globalThis as unknown as { expo?: unknown }).expo = {
  EventEmitter: MockExpoEventEmitter,
};

// Provide in-memory localStorage, window, and minimal DOM for React 19 createRoot in Node
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

if (typeof globalThis.localStorage === "undefined") {
  Object.defineProperty(globalThis, "localStorage", {
    value: mockLocalStorage,
    configurable: true,
    writable: true,
  });
}

if (typeof globalThis.HTMLIFrameElement === "undefined") {
  (globalThis as unknown as { HTMLIFrameElement?: unknown }).HTMLIFrameElement =
    function HTMLIFrameElement() {};
}

if (typeof globalThis.window === "undefined") {
  Object.defineProperty(globalThis, "window", {
    value: globalThis,
    configurable: true,
    writable: true,
  });
} else if (!globalThis.window.localStorage) {
  Object.defineProperty(globalThis.window, "localStorage", {
    value: mockLocalStorage,
    configurable: true,
    writable: true,
  });
}

if (typeof globalThis.document === "undefined") {
  interface MiniNode {
    nodeType: number;
    nodeValue?: string;
    tagName?: string;
    nodeName?: string;
    childNodes?: MiniNode[];
    children?: MiniNode[];
    style?: Record<string, unknown>;
    dataset?: Record<string, string>;
    attributes?: Map<string, string>;
    listeners?: Map<string, Set<(ev: unknown) => void>>;
    ownerDocument: unknown;
    parentNode?: MiniNode | null;
    type?: string;
    value?: string;
    checked?: boolean;
    disabled?: boolean;
    textContent?: string;
  }

  const makeEl = (tag: string, ownerDocument: unknown): MiniNode => {
    const attrs = new Map<string, string>();
    const listeners = new Map<string, Set<(ev: unknown) => void>>();
    const childNodes: MiniNode[] = [];
    const el: MiniNode & Record<string, unknown> = {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      nodeName: tag.toUpperCase(),
      childNodes,
      get children() {
        return childNodes.filter((c) => c.nodeType === 1);
      },
      style: {},
      dataset: {},
      attributes: attrs,
      listeners,
      ownerDocument,
      parentNode: null,
      appendChild(c: MiniNode) {
        c.parentNode = el;
        childNodes.push(c);
        return c;
      },
      removeChild(c: MiniNode) {
        const idx = childNodes.indexOf(c);
        if (idx >= 0) childNodes.splice(idx, 1);
        c.parentNode = null;
        return c;
      },
      insertBefore(c: MiniNode, ref: MiniNode | null) {
        const idx = ref ? childNodes.indexOf(ref) : -1;
        if (idx >= 0) childNodes.splice(idx, 0, c);
        else childNodes.push(c);
        c.parentNode = el;
        return c;
      },
      setAttribute(k: string, v: string) {
        attrs.set(k, String(v));
        if (k === "type") el.type = String(v);
      },
      getAttribute(k: string) {
        return attrs.get(k) ?? null;
      },
      removeAttribute(k: string) {
        attrs.delete(k);
      },
      hasAttribute(k: string) {
        return attrs.has(k);
      },
      addEventListener(type: string, fn: (ev: unknown) => void) {
        let set = listeners.get(type);
        if (!set) {
          set = new Set();
          listeners.set(type, set);
        }
        set.add(fn);
      },
      removeEventListener(type: string, fn: (ev: unknown) => void) {
        listeners.get(type)?.delete(fn);
      },
      dispatchEvent(ev: { type: string; target?: unknown; currentTarget?: unknown }) {
        ev.target = ev.target ?? el;
        ev.currentTarget = el;
        const set = listeners.get(ev.type);
        if (set) {
          for (const fn of Array.from(set)) fn(ev);
        }
        return true;
      },
      get textContent(): string {
        return childNodes.map((c) => c.nodeValue ?? c.textContent ?? "").join("");
      },
      set textContent(v: string) {
        childNodes.length = 0;
        const s = String(v ?? "");
        if (s.length > 0) {
          childNodes.push({ nodeType: 3, nodeValue: s, ownerDocument });
        }
      },
    };
    return el;
  };

  const docListeners = new Map<string, Set<(ev: unknown) => void>>();
  const doc: Record<string, unknown> = {
    nodeType: 9,
    defaultView: globalThis.window,
    body: null,
    addEventListener(type: string, fn: (ev: unknown) => void) {
      let set = docListeners.get(type);
      if (!set) {
        set = new Set();
        docListeners.set(type, set);
      }
      set.add(fn);
    },
    removeEventListener(type: string, fn: (ev: unknown) => void) {
      docListeners.get(type)?.delete(fn);
    },
    createElement: (tag: string) => makeEl(tag, doc),
    createElementNS: (_ns: string, tag: string) => makeEl(tag, doc),
    createTextNode: (t: string) => ({ nodeType: 3, nodeValue: String(t), ownerDocument: doc }),
    createComment: (t: string) => ({ nodeType: 8, nodeValue: String(t), ownerDocument: doc }),
  };
  doc.body = makeEl("body", doc);
  Object.defineProperty(globalThis, "document", {
    value: doc,
    configurable: true,
    writable: true,
  });
}

vi.mock("expo-modules-core", () => ({
  requireOptionalNativeModule: (name: string) => {
    if (name === "SonarMeshNative" && !mockNativeState.moduleNull) {
      return mockSonarMeshNative;
    }
    return null;
  },
  EventEmitter: MockExpoEventEmitter,
}));

vi.mock("expo-sqlite", () => ({
  openDatabaseAsync: async (_dbName: string) => {
    if (mockSqliteState.openError) {
      throw mockSqliteState.openError;
    }
    return mockSqliteDb;
  },
}));

vi.mock("expo-location", () => ({
  PermissionStatus: {
    GRANTED: "granted",
    DENIED: "denied",
    UNDETERMINED: "undetermined",
  },
  Accuracy: {
    Lowest: 1,
    Low: 2,
    Balanced: 3,
    High: 4,
    Highest: 5,
    BestForNavigation: 6,
  },
  async getForegroundPermissionsAsync() {
    if (mockLocationState.error) throw mockLocationState.error;
    return {
      status: mockLocationState.permissionStatus,
      granted: mockLocationState.permissionStatus === "granted",
      canAskAgain: mockLocationState.canAskAgain,
    };
  },
  async requestForegroundPermissionsAsync() {
    if (mockLocationState.error) throw mockLocationState.error;
    return {
      status: mockLocationState.permissionStatus,
      granted: mockLocationState.permissionStatus === "granted",
      canAskAgain: mockLocationState.canAskAgain,
    };
  },
  async getCurrentPositionAsync() {
    if (mockLocationState.error) throw mockLocationState.error;
    if (mockLocationState.permissionStatus !== "granted") {
      throw new Error("Location permission not granted");
    }
    return {
      coords: {
        latitude: mockLocationState.coords.latitude,
        longitude: mockLocationState.coords.longitude,
        accuracy: mockLocationState.coords.accuracy,
      },
      timestamp: Date.now(),
    };
  },
  async getLastKnownPositionAsync() {
    if (mockLocationState.error) throw mockLocationState.error;
    if (!mockLocationState.lastKnownCoords) return null;
    return {
      coords: {
        latitude: mockLocationState.lastKnownCoords.latitude,
        longitude: mockLocationState.lastKnownCoords.longitude,
        accuracy: mockLocationState.lastKnownCoords.accuracy,
      },
      timestamp: Date.now(),
    };
  },
}));

beforeEach(() => {
  resetAllBoundaryMocks();
});
