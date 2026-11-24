import React from "react";

function createSvgElement(tag: string) {
  return function SvgElement(props: Record<string, unknown>) {
    const { onPress, children, ...rest } = props;
    const htmlProps: Record<string, unknown> = { ...rest };
    if (typeof onPress === "function") {
      htmlProps.onClick = onPress;
    }
    return React.createElement(tag, htmlProps, children as React.ReactNode);
  };
}

export const Svg = createSvgElement("svg");
export const Circle = createSvgElement("circle");
export const Rect = createSvgElement("rect");
export const Line = createSvgElement("line");
export const Path = createSvgElement("path");
export const Polygon = createSvgElement("polygon");
export const Polyline = createSvgElement("polyline");
export const G = createSvgElement("g");
export const Defs = createSvgElement("defs");
export const LinearGradient = createSvgElement("linearGradient");
export const RadialGradient = createSvgElement("radialGradient");
export const Stop = createSvgElement("stop");
export const Text = createSvgElement("text");
export const TSpan = createSvgElement("tspan");

export default Svg;
