import './globals.css';

export const metadata={
  title:'ManagerLens — MF Manager Decision Intelligence',
  description:'Live manager-first mutual fund analytics using MFapi.in, AMFI and verified AMC manager records.'
};

export default function RootLayout({children}){
  return <html lang="en"><body>{children}</body></html>;
}
