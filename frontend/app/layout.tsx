import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "GhostAI — Intelligence Beyond the Ordinary",
  description: "A local-first AI assistant powered by Ollama and open-weight models.",
};
export const viewport: Viewport = { themeColor: "#0b0a12", colorScheme: "dark" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
