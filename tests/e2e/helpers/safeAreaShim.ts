import React from "react";

export function SafeAreaProvider(props: { children?: React.ReactNode }) {
  return React.createElement("div", { "data-rn": "SafeAreaProvider" }, props.children);
}

export function SafeAreaView(props: Record<string, unknown>) {
  return React.createElement(
    "div",
    {
      "data-rn": "SafeAreaView",
      "data-testid": props.testID,
      style: props.style,
    },
    props.children as React.ReactNode
  );
}

export function useSafeAreaInsets() {
  return { top: 0, right: 0, bottom: 0, left: 0 };
}

export function useSafeAreaFrame() {
  return { x: 0, y: 0, width: 390, height: 844 };
}

export const initialWindowMetrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 0, right: 0, bottom: 0, left: 0 },
};
