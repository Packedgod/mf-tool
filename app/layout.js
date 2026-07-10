import './globals.css';
import './universe.css';
import { Suspense } from 'react';
import UniverseLauncher from '@/components/UniverseLauncher';
import UniverseBridge from '@/components/UniverseBridge';

export const metadata={
  title:'ManagerLens — MF Manager Decision Intelligence',
  description:'Live manager-first mutual fund analytics using MFapi.in, AMFI and verified AMC manager records.'
};

export default function RootLayout({children}){
  return (
    <html lang="en">
      <body>
        {children}
        <UniverseLauncher />
        <Suspense fallback={null}><UniverseBridge /></Suspense>
      </body>
    </html>
  );
}
