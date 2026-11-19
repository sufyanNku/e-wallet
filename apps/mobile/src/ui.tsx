import { type PropsWithChildren } from "react";
import {
  Pressable,
  Text,
  TextInput,
  View,
  StyleSheet,
  type TextInputProps,
} from "react-native";
import Svg, { Path, Circle } from "react-native-svg";
export const color = {
  bg: "#141318",
  surface: "#211f28",
  line: "#343a37",
  text: "#f1f5ec",
  muted: "#aaa4b6",
  accent: "#bda6ff",
  negative: "#efa9ac",
};
const paths: Record<string, string> = {
  send: "M7 17 17 7M7 7h10v10",
  receive: "M17 7 7 17M7 7v10h10",
  swap: "m4 7 3-3-3-3M7 4h12M20 17l-3 3 3 3M17 20H5",
  wallet: "M4 6h15v14H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h12M15 11h6v5h-6z",
  activity: "M3 12h4l3-8 4 16 3-8h4",
  settings:
    "m10 3-1 3-3 1-3 3 2 2-1 4 3 2 3-1 2 3 3-1 1-3 3-2-1-4 2-2-3-3-3-1-1-3z",
  back: "m14 5-7 7 7 7",
  chevron: "m9 5 7 7-7 7",
  copy: "M8 8h12v13H8zM4 16H2V2h13v2",
  lock: "M5 10h14v11H5zM8 10V6a4 4 0 0 1 8 0v4",
  scan: "M3 8V3h5M16 3h5v5M21 16v5h-5M8 21H3v-5M7 12h10",
  search: "m16 16 5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  check: "m4 12 5 5L20 6",
  add: "M12 4v16M4 12h16",
  image: "M3 3h18v18H3zM3 16l6-7 5 6 3-3 4 5",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
  close: "m5 5 14 14M19 5 5 19",
  compass: "m8 16 3-7 5-2-3 7z",
};
export function Icon({
  name,
  size = 22,
  tint = color.text,
}: {
  name: string;
  size?: number;
  tint?: string;
}) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={tint}
      strokeWidth={1.65}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {name === "compass" && <Circle cx="12" cy="12" r="10" />}
      <Path d={paths[name] ?? paths.wallet} />
    </Svg>
  );
}
export function Mark() {
  return (
    <View style={ui.mark}>
      <Text style={ui.markText}>e</Text>
    </View>
  );
}
export function Button({
  children,
  onPress,
  secondary = false,
  disabled = false,
  label,
}: {
  children: React.ReactNode;
  onPress: () => void;
  secondary?: boolean;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        ui.button,
        secondary && ui.secondary,
        disabled && { opacity: 0.45 },
        pressed && { opacity: 0.75 },
      ]}
    >
      <Text style={[ui.buttonText, secondary && { color: color.text }]}>
        {children}
      </Text>
    </Pressable>
  );
}
export function Input({ label, ...props }: TextInputProps & { label: string }) {
  return (
    <View style={ui.field}>
      <Text style={ui.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor="#7f8a80"
        autoCapitalize="none"
        autoCorrect={false}
        style={[
          ui.input,
          props.multiline && { minHeight: 110, textAlignVertical: "top" },
        ]}
        {...props}
      />
    </View>
  );
}
export function Note({
  children,
  error = false,
}: PropsWithChildren<{ error?: boolean }>) {
  return (
    <View
      accessibilityRole={error ? "alert" : "text"}
      style={[
        ui.note,
        error && { borderColor: "#70474b", backgroundColor: "#302324" },
      ]}
    >
      <Text style={[ui.noteText, error && { color: color.negative }]}>
        {children}
      </Text>
    </View>
  );
}
export function Row({
  label,
  value,
  onPress,
}: {
  label: string;
  value?: string;
  onPress?: () => void;
}) {
  return (
    <Pressable
      accessibilityRole={onPress ? "button" : "text"}
      onPress={onPress}
      disabled={!onPress}
      style={ui.row}
    >
      <Text style={ui.rowLabel}>{label}</Text>
      <Text style={ui.rowValue} numberOfLines={1}>
        {value}
      </Text>
      {onPress && <Icon name="chevron" size={16} tint={color.muted} />}
    </Pressable>
  );
}
export function Coin({ symbol }: { symbol: string }) {
  const c =
    symbol === "ETH"
      ? "#34394e"
      : symbol === "BTC"
        ? "#ce8934"
        : symbol === "SOL"
          ? "#34413c"
          : "#365d7e";
  return (
    <View style={[ui.coin, { backgroundColor: c }]}>
      <Text style={ui.coinText}>
        {symbol === "ETH"
          ? "Ξ"
          : symbol === "BTC"
            ? "₿"
            : symbol === "SOL"
              ? "◎"
              : symbol.includes("USD")
                ? "$"
                : symbol.slice(0, 1)}
      </Text>
    </View>
  );
}
export const ui = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.bg },
  content: {
    paddingHorizontal: 22,
    paddingTop: 22,
    paddingBottom: 35,
    gap: 18,
  },
  title: {
    fontSize: 30,
    fontWeight: "600",
    letterSpacing: -1.1,
    color: color.text,
  },
  subtitle: { fontSize: 13, lineHeight: 21, color: color.muted },
  mark: {
    width: 52,
    height: 52,
    borderRadius: 17,
    borderBottomLeftRadius: 4,
    backgroundColor: color.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  markText: {
    fontSize: 46,
    fontStyle: "italic",
    fontWeight: "800",
    color: "#2d1c4b",
    lineHeight: 50,
  },
  button: {
    minHeight: 53,
    borderRadius: 14,
    backgroundColor: color.accent,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 20,
  },
  secondary: {
    backgroundColor: "#282f2b",
    borderWidth: 1,
    borderColor: color.line,
  },
  buttonText: { color: "#2d1c4b", fontSize: 14, fontWeight: "700" },
  field: { gap: 9 },
  label: { fontSize: 12, color: color.muted, fontWeight: "500" },
  input: {
    backgroundColor: "#211e29",
    borderWidth: 1,
    borderColor: "#4a4259",
    borderRadius: 13,
    padding: 15,
    color: color.text,
    fontSize: 15,
    minHeight: 52,
  },
  note: {
    padding: 15,
    borderWidth: 1,
    borderColor: "#5b496e",
    backgroundColor: "#30273e",
    borderRadius: 13,
  },
  noteText: { color: "#ded1f0", fontSize: 12, lineHeight: 19 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 19,
    borderBottomWidth: 1,
    borderColor: color.line,
    minHeight: 58,
  },
  rowLabel: { fontSize: 14, color: color.text },
  rowValue: { color: color.muted, fontSize: 12, flex: 1, textAlign: "right" },
  coin: {
    height: 43,
    width: 43,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  coinText: { fontSize: 26, color: "#f1f5ec" },
  card: {
    backgroundColor: color.surface,
    borderRadius: 20,
    padding: 20,
    borderWidth: 1,
    borderColor: color.line,
  },
  sectionTitle: { fontSize: 17, fontWeight: "600", color: color.text },
  back: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingTop: 12,
    paddingHorizontal: 14,
    minHeight: 50,
  },
  backText: { fontSize: 13, color: color.muted },
});
