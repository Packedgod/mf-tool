import AllManagerAnalyticsApp from '@/components/AllManagerAnalyticsApp';

export default function Home({ searchParams }) {
  return (
    <AllManagerAnalyticsApp
      initialManagerName={searchParams?.managerName || ''}
      initialAmfiCode={searchParams?.amfiCode || ''}
    />
  );
}
