import{NextResponse}from'next/server';
import{health}from'@/lib/upstream';
export const dynamic='force-dynamic';
export const revalidate=0;
export async function GET(){
  try{return NextResponse.json({ok:true,...await health()},{headers:{'Cache-Control':'no-store'}})}
  catch(e){return NextResponse.json({ok:false,mfapi:'degraded',amfi:'degraded',detail:e instanceof Error?e.message:String(e)},{status:200,headers:{'Cache-Control':'no-store'}})}
}
