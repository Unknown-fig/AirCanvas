import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Air Canvas',
  description: 'Real-time in-browser drawing in the air with hand tracking',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full w-full overflow-hidden bg-black">
      <body className="h-full w-full overflow-hidden bg-black text-white antialiased">
        {children}
      </body>
    </html>
  );
}
