import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "svara — scheme helpline",
  description: "Real-time Indic voice agent with a first-class evaluation harness",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav>
          <Link href="/">Call</Link>
          <Link href="/evals">Eval runs</Link>
          <Link href="/traces">Live traces</Link>
        </nav>
        {children}
      </body>
    </html>
  );
}
