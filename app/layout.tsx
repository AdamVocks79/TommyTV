import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TommyTV Football Stats",
  description: "Fast, collaborative football statistics for Friday night broadcasts.",
  applicationName: "TommyTV Stats",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "TommyTV Stats",
  },
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: "#07111f",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
