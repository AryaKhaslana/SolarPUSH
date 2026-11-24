import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { COLORS, FONTS } from "@/theme/tokens";

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
}

export class AppErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, message: "" };
  }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return {
      hasError: true,
      message: error instanceof Error ? error.message : "Terjadi kesalahan tak terduga.",
    };
  }

  componentDidCatch(error: unknown) {
    console.warn("[SonarMesh ErrorBoundary]", error);
  }

  private handleReset = () => {
    this.setState({ hasError: false, message: "" });
  };

  render() {
    if (this.state.hasError) {
      return (
        <View style={styles.root}>
          <View style={styles.card}>
            <Text style={styles.title}>SonarMesh mengalami kendala tampilan</Text>
            <Text style={styles.body}>
              Aplikasi tetap aman. Ketuk tombol di bawah untuk memuat ulang layar utama.
            </Text>
            {this.state.message ? (
              <Text style={styles.detail}>{this.state.message}</Text>
            ) : null}
            <Pressable
              onPress={this.handleReset}
              style={styles.button}
              accessibilityRole="button"
            >
              <Text style={styles.buttonText}>Muat Ulang Aplikasi</Text>
            </Pressable>
          </View>
        </View>
      );
    }

    return this.props.children;
  }
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: COLORS.ground,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  card: {
    width: "100%",
    maxWidth: 380,
    backgroundColor: COLORS.surface,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 16,
    padding: 20,
    gap: 10,
  },
  title: {
    fontFamily: FONTS.sansMedium,
    fontSize: 18,
    fontWeight: "700",
    color: COLORS.text,
  },
  body: {
    fontFamily: FONTS.sans,
    fontSize: 14,
    lineHeight: 20,
    color: COLORS.muted,
  },
  detail: {
    fontFamily: FONTS.mono,
    fontSize: 12,
    color: COLORS.sos,
    backgroundColor: COLORS.sosSoft,
    padding: 10,
    borderRadius: 8,
  },
  button: {
    marginTop: 6,
    height: 46,
    borderRadius: 10,
    backgroundColor: COLORS.sonar,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonText: {
    fontFamily: FONTS.sansMedium,
    fontSize: 14,
    fontWeight: "600",
    color: COLORS.white,
  },
});
