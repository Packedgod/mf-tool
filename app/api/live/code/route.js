import{NextResponse}from'next/server';
import{codeOf,resolveByCode,history}from'@/lib/upstream';
export const dynamic='force-dynamic';
export const revalidate=0;
export async function GET(req){
  const code=codeOf(new URL(req.url).searchParams.get('code'));
  if(!code)return NextResponse.json({ok:false,error:'Enter a valid 4 to 9 digit AMFI code.'},{status:400});
  try{
    const resolved=await resolveByCode(code);
    const data=await history(code);
    return NextResponse.json({ok:true,schemeCode:code,schemeName:resolved.schemeName,resolvedBy:resolved.resolvedBy,observations:Array.isArray(data.data)?data.data.length:0,meta:data.meta||{}},{headers:{'Cache-Control':'no-store'}});
  }catch(e){
    return NextResponse.json({ok:false,error:e instanceof Error?e.message:String(e)},{status:404,headers:{'Cache-Control':'no-store'}});
  }
}
