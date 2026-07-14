import './globals.css';
import './universe.css';
import './all-manager.css';
import './analytics-enhancements.css';
import UniverseLauncher from '@/components/UniverseLauncher';

export const metadata={
  title:'ManagerLens — Indian MF Manager Decision Intelligence',
  description:'India-wide manager-first mutual fund analytics using AMFI, MFapi.in, Yahoo Finance and source-tracked AMC manager records.'
};

export default function RootLayout({children}){
  return (
    <html lang="en">
      <body>
        {children}
        <UniverseLauncher />
      </body>
    </html>
  );
}
