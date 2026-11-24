import React from "react";
import {
  mockOsState,
  type MockAndroidPermissionResult,
  type MockPlatformOS,
} from "./nativeMocks";

type StyleValue = Record<string, unknown> | StyleValue[] | null | undefined | false;

function flattenStyle(style: StyleValue): Record<string, unknown> | undefined {
  if (!style) return undefined;
  if (Array.isArray(style)) {
    const merged: Record<string, unknown> = {};
    for (const item of style) {
      const flat = flattenStyle(item);
      if (flat) Object.assign(merged, flat);
    }
    return Object.keys(merged).length > 0 ? merged : undefined;
  }
  if (typeof style === "object") {
    return { ...style };
  }
  return undefined;
}

function buildHtmlProps(
  rnType: string,
  props: Record<string, unknown>,
  extra?: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    "data-rn": rnType,
  };
  if (props.testID !== undefined) out["data-testid"] = props.testID;
  if (props.id !== undefined) out.id = props.id;
  if (props.accessibilityLabel !== undefined) out["aria-label"] = props.accessibilityLabel;
  if (props.accessibilityRole !== undefined) out.role = props.accessibilityRole;
  if (props.accessibilityState !== undefined) {
    const st = props.accessibilityState as Record<string, unknown>;
    if (st.disabled !== undefined) out["aria-disabled"] = st.disabled;
    if (st.selected !== undefined) out["aria-selected"] = st.selected;
    if (st.checked !== undefined) out["aria-checked"] = st.checked;
  }
  const resolvedStyle =
    typeof props.style === "function"
      ? (props.style as (s: { pressed: boolean }) => StyleValue)({ pressed: false })
      : (props.style as StyleValue);
  const flatStyle = flattenStyle(resolvedStyle);
  if (flatStyle) {
    out.style = flatStyle;
  }
  if (extra) {
    Object.assign(out, extra);
  }
  return out;
}

function resolveChildren(children: unknown): React.ReactNode {
  if (typeof children === "function") {
    return (children as (s: { pressed: boolean }) => React.ReactNode)({ pressed: false });
  }
  return children as React.ReactNode;
}

export const View = React.forwardRef<unknown, Record<string, unknown>>(function View(props, ref) {
  return React.createElement(
    "div",
    { ...buildHtmlProps("View", props), ref },
    resolveChildren(props.children)
  );
});

export const SafeAreaView = React.forwardRef<unknown, Record<string, unknown>>(
  function SafeAreaView(props, ref) {
    return React.createElement(
      "div",
      { ...buildHtmlProps("SafeAreaView", props), ref },
      resolveChildren(props.children)
    );
  }
);

export const ScrollView = React.forwardRef<unknown, Record<string, unknown>>(
  function ScrollView(props, ref) {
    return React.createElement(
      "div",
      { ...buildHtmlProps("ScrollView", props), ref },
      resolveChildren(props.children)
    );
  }
);

export const KeyboardAvoidingView = React.forwardRef<unknown, Record<string, unknown>>(
  function KeyboardAvoidingView(props, ref) {
    return React.createElement(
      "div",
      { ...buildHtmlProps("KeyboardAvoidingView", props), ref },
      resolveChildren(props.children)
    );
  }
);

export const Text = React.forwardRef<unknown, Record<string, unknown>>(function Text(props, ref) {
  const extra: Record<string, unknown> = {};
  if (typeof props.onPress === "function") {
    extra.onClick = props.onPress;
  }
  return React.createElement(
    "span",
    { ...buildHtmlProps("Text", props, extra), ref },
    resolveChildren(props.children)
  );
});

export const Pressable = React.forwardRef<unknown, Record<string, unknown>>(
  function Pressable(props, ref) {
    const disabled = Boolean(props.disabled);
    const extra: Record<string, unknown> = {
      type: "button",
      disabled,
      onClick: (ev: unknown) => {
        if (!disabled && typeof props.onPress === "function") {
          (props.onPress as (e: unknown) => void)(ev);
        }
      },
    };
    return React.createElement(
      "button",
      { ...buildHtmlProps("Pressable", props, extra), ref },
      resolveChildren(props.children)
    );
  }
);

export const TouchableOpacity = React.forwardRef<unknown, Record<string, unknown>>(
  function TouchableOpacity(props, ref) {
    const disabled = Boolean(props.disabled);
    const extra: Record<string, unknown> = {
      type: "button",
      disabled,
      onClick: (ev: unknown) => {
        if (!disabled && typeof props.onPress === "function") {
          (props.onPress as (e: unknown) => void)(ev);
        }
      },
    };
    return React.createElement(
      "button",
      { ...buildHtmlProps("TouchableOpacity", props, extra), ref },
      resolveChildren(props.children)
    );
  }
);

export const TextInput = React.forwardRef<unknown, Record<string, unknown>>(
  function TextInput(props, ref) {
    const editable = props.editable !== false;
    const extra: Record<string, unknown> = {
      type: "text",
      disabled: !editable,
      placeholder: props.placeholder,
      maxLength: props.maxLength,
      onChange: (ev: { target?: { value?: string } }) => {
        if (typeof props.onChange === "function") {
          (props.onChange as (e: unknown) => void)(ev);
        }
        if (typeof props.onChangeText === "function") {
          (props.onChangeText as (t: string) => void)(ev?.target?.value ?? "");
        }
      },
    };
    if (props.value !== undefined) extra.value = props.value;
    if (props.defaultValue !== undefined) extra.defaultValue = props.defaultValue;
    return React.createElement("input", {
      ...buildHtmlProps("TextInput", props, extra),
      ref,
    });
  }
);

export const Switch = React.forwardRef<unknown, Record<string, unknown>>(
  function Switch(props, ref) {
    const disabled = Boolean(props.disabled);
    const extra: Record<string, unknown> = {
      type: "checkbox",
      role: "switch",
      checked: Boolean(props.value),
      disabled,
      onChange: (ev: { target?: { checked?: boolean } }) => {
        const next = ev?.target?.checked !== undefined ? Boolean(ev.target.checked) : !Boolean(props.value);
        if (typeof props.onValueChange === "function") {
          (props.onValueChange as (v: boolean) => void)(next);
        }
      },
    };
    return React.createElement("input", {
      ...buildHtmlProps("Switch", props, extra),
      ref,
    });
  }
);

export function FlatList<T = unknown>(props: {
  data?: T[] | null;
  renderItem: (info: { item: T; index: number }) => React.ReactNode;
  keyExtractor?: (item: T, index: number) => string;
  ListEmptyComponent?: React.ComponentType | React.ReactElement | null;
  ListHeaderComponent?: React.ComponentType | React.ReactElement | null;
  ListFooterComponent?: React.ComponentType | React.ReactElement | null;
  testID?: string;
  style?: StyleValue;
}) {
  const items = props.data ?? [];
  const renderSlot = (slot?: React.ComponentType | React.ReactElement | null) => {
    if (!slot) return null;
    if (React.isValidElement(slot)) return slot;
    const Comp = slot as React.ComponentType;
    return React.createElement(Comp);
  };

  return React.createElement(
    "div",
    buildHtmlProps("FlatList", props as unknown as Record<string, unknown>),
    renderSlot(props.ListHeaderComponent),
    items.length === 0
      ? renderSlot(props.ListEmptyComponent)
      : items.map((item, index) => {
          const key = props.keyExtractor
            ? props.keyExtractor(item, index)
            : String(index);
          return React.createElement(
            React.Fragment,
            { key },
            props.renderItem({ item, index })
          );
        }),
    renderSlot(props.ListFooterComponent)
  );
}

export function Modal(props: Record<string, unknown>) {
  if (props.visible === false) return null;
  return React.createElement(
    "div",
    buildHtmlProps("Modal", props, {
      role: "dialog",
      "aria-modal": "true",
    }),
    resolveChildren(props.children)
  );
}

export function ActivityIndicator(props: Record<string, unknown>) {
  return React.createElement("div", buildHtmlProps("ActivityIndicator", props, { role: "progressbar" }));
}

export function Image(props: Record<string, unknown>) {
  return React.createElement("img", buildHtmlProps("Image", props, { alt: props.accessibilityLabel ?? "" }));
}

export function RefreshControl(props: Record<string, unknown>) {
  return React.createElement("div", buildHtmlProps("RefreshControl", props));
}

export const Platform = {
  get OS(): MockPlatformOS {
    return mockOsState.platformOS;
  },
  set OS(val: MockPlatformOS) {
    mockOsState.platformOS = val;
  },
  get Version(): number {
    return mockOsState.platformVersion;
  },
  set Version(val: number) {
    mockOsState.platformVersion = val;
  },
  select<T>(specifics: { android?: T; web?: T; ios?: T; native?: T; default?: T }): T | undefined {
    const os = mockOsState.platformOS;
    if (os in specifics && specifics[os] !== undefined) {
      return specifics[os];
    }
    if (os !== "web" && specifics.native !== undefined) {
      return specifics.native;
    }
    return specifics.default;
  },
};

export const PermissionsAndroid = {
  PERMISSIONS: {
    BLUETOOTH_SCAN: "android.permission.BLUETOOTH_SCAN",
    BLUETOOTH_ADVERTISE: "android.permission.BLUETOOTH_ADVERTISE",
    BLUETOOTH_CONNECT: "android.permission.BLUETOOTH_CONNECT",
    ACCESS_FINE_LOCATION: "android.permission.ACCESS_FINE_LOCATION",
    ACCESS_COARSE_LOCATION: "android.permission.ACCESS_COARSE_LOCATION",
    ACCESS_BACKGROUND_LOCATION: "android.permission.ACCESS_BACKGROUND_LOCATION",
    RECORD_AUDIO: "android.permission.RECORD_AUDIO",
    POST_NOTIFICATIONS: "android.permission.POST_NOTIFICATIONS",
  },
  RESULTS: {
    GRANTED: "granted" as const,
    DENIED: "denied" as const,
    NEVER_ASK_AGAIN: "never_ask_again" as const,
  },
  async check(permission: string): Promise<boolean> {
    if (mockOsState.permissionError) throw mockOsState.permissionError;
    return mockOsState.permissions.get(permission) === "granted";
  },
  async request(permission: string, _rationale?: unknown): Promise<MockAndroidPermissionResult> {
    if (mockOsState.permissionError) throw mockOsState.permissionError;
    return mockOsState.permissions.get(permission) ?? "denied";
  },
  async requestMultiple(
    permissions: string[]
  ): Promise<Record<string, MockAndroidPermissionResult>> {
    if (mockOsState.permissionError) throw mockOsState.permissionError;
    const out: Record<string, MockAndroidPermissionResult> = {};
    for (const p of permissions) {
      out[p] = mockOsState.permissions.get(p) ?? "denied";
    }
    return out;
  },
};

export const Linking = {
  async openSettings(): Promise<void> {
    mockOsState.linkingOpenSettingsCalls += 1;
    if (mockOsState.linkingError) throw mockOsState.linkingError;
  },
  async openURL(url: string): Promise<void> {
    mockOsState.linkingOpenUrlCalls.push(url);
    if (mockOsState.linkingError) throw mockOsState.linkingError;
  },
  async canOpenURL(_url: string): Promise<boolean> {
    return true;
  },
};

export const StyleSheet = {
  create<T extends Record<string, unknown>>(styles: T): T {
    return styles;
  },
  flatten: flattenStyle,
  hairlineWidth: 1,
  absoluteFill: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0 },
  absoluteFillObject: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0 },
};

export const AppState = {
  get currentState() {
    return mockOsState.appStateCurrent;
  },
  addEventListener(_type: string, listener: (state: string) => void) {
    mockOsState.appStateListeners.add(listener);
    return {
      remove: () => {
        mockOsState.appStateListeners.delete(listener);
      },
    };
  },
};

export const BackHandler = {
  addEventListener(_eventName: string, handler: () => boolean) {
    mockOsState.backHandlerListeners.add(handler);
    return {
      remove: () => {
        mockOsState.backHandlerListeners.delete(handler);
      },
    };
  },
  exitApp() {},
};

export const Alert = {
  alert(title: string, message?: string, buttons?: unknown[]) {
    mockOsState.alertCalls.push({ title, message, buttons });
  },
};

export const Dimensions = {
  get(_dim: "window" | "screen") {
    return { width: 390, height: 844, scale: 3, fontScale: 1 };
  },
  addEventListener() {
    return { remove: () => {} };
  },
};

export function useColorScheme(): "light" | "dark" | null {
  return mockOsState.colorScheme;
}

export const PixelRatio = {
  get: () => 3,
  roundToNearestPixel: (n: number) => Math.round(n),
};

export const Vibration = {
  vibrate: () => {},
  cancel: () => {},
};

export const Share = {
  async share() {
    return { action: "sharedAction" };
  },
};

class AnimatedValue {
  private val: number;
  constructor(initial: number) {
    this.val = initial;
  }
  setValue(next: number) {
    this.val = next;
  }
  interpolate() {
    return this;
  }
  addListener() {
    return "0";
  }
  removeListener() {}
  removeAllListeners() {}
  __getValue() {
    return this.val;
  }
}

class AnimatedValueXY {
  x: AnimatedValue;
  y: AnimatedValue;
  constructor(initial = { x: 0, y: 0 }) {
    this.x = new AnimatedValue(initial.x);
    this.y = new AnimatedValue(initial.y);
  }
  setValue(next: { x: number; y: number }) {
    this.x.setValue(next.x);
    this.y.setValue(next.y);
  }
  getLayout() {
    return { left: 0, top: 0 };
  }
}

function makeAnimResult() {
  return {
    start: (cb?: (result: { finished: boolean }) => void) => {
      cb?.({ finished: true });
    },
    stop: () => {},
    reset: () => {},
  };
}

export const Animated = {
  Value: AnimatedValue,
  ValueXY: AnimatedValueXY,
  timing: () => makeAnimResult(),
  spring: () => makeAnimResult(),
  decay: () => makeAnimResult(),
  loop: () => makeAnimResult(),
  sequence: () => makeAnimResult(),
  parallel: () => makeAnimResult(),
  stagger: () => makeAnimResult(),
  createAnimatedComponent: <T>(Component: T): T => Component,
  View,
  Text,
  ScrollView,
  Image,
  FlatList,
  Easing: {
    linear: (t: number) => t,
    ease: (t: number) => t,
    bezier: () => (t: number) => t,
    inOut: (fn: (t: number) => number) => fn,
  },
};

export default {
  View,
  SafeAreaView,
  ScrollView,
  KeyboardAvoidingView,
  Text,
  Pressable,
  TouchableOpacity,
  TextInput,
  Switch,
  FlatList,
  Modal,
  ActivityIndicator,
  Image,
  RefreshControl,
  Platform,
  PermissionsAndroid,
  Linking,
  StyleSheet,
  AppState,
  BackHandler,
  Alert,
  Dimensions,
  useColorScheme,
  PixelRatio,
  Vibration,
  Share,
  Animated,
};
