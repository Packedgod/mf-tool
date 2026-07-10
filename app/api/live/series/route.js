import {NextResponse} from 'next/server';
import{codeOf,liveSeries}from '@/lib/upstream';
export const dynamic='force-dynamic';
export const revalidate=0;
export async function POST(req){
  try{
    const b=await req.json();
    const schemeCode=codeOf(b?.schemeCode);
    const queries=Array.isArray(b?.queries)?b.queries.filter(Boolean).slice(0,6):[];
    if(b?.schemeCode&&!schemeCode)return NextResponse.json({ok:false,error:'AMFI scheme code must contain 4 to 9 digits.'},{status:400});
    if(!schemeCode&&!queries.length)return NextResponse.json({ok:false,error:'Provide a valid AMFI code or scheme query.'},{status:400});
    return NextResponse.json(await liveSeries({schemeCode,queries,startDate:b?.startDate,endDate:b?.endDate}),{headers:{'Cache-Control':'no-store'}});
  }catch(e){
    return NextResponse.json({ok:false,error:'Live MF data could not be loaded.',detail:e instanceof Error?e.message:String(e)},{status:503});
  }
}
