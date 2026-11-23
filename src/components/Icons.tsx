import React from "react";
import Svg, { Circle, Line, Path, Rect } from "react-native-svg";

interface IconProps {
  color: string;
  size?: number;
}

export function IconSosBeacon({ color, size = 20 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx={12} cy={12} r={9} stroke={color} strokeWidth={1.8} />
      <Circle cx={12} cy={12} r={4.2} fill={color} />
    </Svg>
  );
}

export function IconRadar({ color, size = 20 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx={12} cy={12} r={9} stroke={color} strokeWidth={1.7} />
      <Circle cx={12} cy={12} r={4.5} stroke={color} strokeWidth={1.4} strokeOpacity={0.65} />
      <Line x1={12} y1={12} x2={18.2} y2={6.8} stroke={color} strokeWidth={1.9} strokeLinecap="round" />
      <Circle cx={12} cy={12} r={1.8} fill={color} />
    </Svg>
  );
}

export function IconLab({ color, size = 20 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Line x1={4} y1={7} x2={20} y2={7} stroke={color} strokeWidth={1.7} strokeLinecap="round" />
      <Circle cx={9} cy={7} r={2.2} fill={color} />
      <Line x1={4} y1={12} x2={20} y2={12} stroke={color} strokeWidth={1.7} strokeLinecap="round" />
      <Circle cx={15} cy={12} r={2.2} fill={color} />
      <Line x1={4} y1={17} x2={20} y2={17} stroke={color} strokeWidth={1.7} strokeLinecap="round" />
      <Circle cx={10} cy={17} r={2.2} fill={color} />
    </Svg>
  );
}

export function IconSiren({ color, size = 18 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M5 17h14M7 17v-5a5 5 0 0 1 10 0v5"
        stroke={color}
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Line x1={12} y1={3} x2={12} y2={5} stroke={color} strokeWidth={1.8} strokeLinecap="round" />
      <Line x1={4.5} y1={6.5} x2={6} y2={8} stroke={color} strokeWidth={1.8} strokeLinecap="round" />
      <Line x1={19.5} y1={6.5} x2={18} y2={8} stroke={color} strokeWidth={1.8} strokeLinecap="round" />
    </Svg>
  );
}

export function IconWave({ color, size = 18 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M3 12h3l2.5-6 4 12 3-8 2.5 2H21"
        stroke={color}
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

export function IconMic({ color, size = 16 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect x={9} y={3} width={6} height={11} rx={3} stroke={color} strokeWidth={1.8} />
      <Path d="M6 11a6 6 0 0 0 12 0M12 17v4M9 21h6" stroke={color} strokeWidth={1.8} strokeLinecap="round" />
    </Svg>
  );
}
