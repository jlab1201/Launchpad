import type { Metadata } from "next";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import { TopBar } from "@/components/top-bar";
import { Toaster } from "@/components/ui/sonner";

export const metadata: Metadata = {
  title: "Dashboard — Internal Webapp Launchpad",
  description:
    "A self-hosted launchpad for internal web apps with credential vault, status monitoring, and auto-screenshots.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          <div className="min-h-screen flex flex-col bg-background text-foreground">
            <TopBar />
            <main className="flex-1">{children}</main>
          </div>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
