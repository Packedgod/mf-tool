import AllManagerAnalyticsApp from '@/components/AllManagerAnalyticsApp';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default function Home({ searchParams }) {
  return (
    <AllManagerAnalyticsApp
      initialManagerName={searchParams?.managerName || ''}
      initialAmfiCode={searchParams?.amfiCode || ''}
    />
  );
}
