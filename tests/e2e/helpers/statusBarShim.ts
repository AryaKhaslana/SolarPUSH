import React from "react";

export function StatusBar(props: { style?: string; backgroundColor?: string }) {
  return React.createElement("div", {
    "data-rn": "StatusBar",
    "data-style": props.style ?? "auto",
    "data-bg": props.backgroundColor,
  });
}

export function setStatusBarStyle(_style: string) {}
export function setStatusBarBackgroundColor(_color: string) {}

export default { StatusBar, setStatusBarStyle, setStatusBarBackgroundColor };
