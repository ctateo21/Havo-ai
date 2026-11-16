/** A deadline includes accounting/cache waits, not only the provider HTTP fetch. */
export async function boundedOptional<T>(work:(signal:AbortSignal)=>Promise<T>,fallback:T,ms=20_000):Promise<T>{
  const controller=new AbortController();
  let timer:ReturnType<typeof setTimeout>;
  try{return await Promise.race([
    Promise.resolve().then(()=>work(controller.signal)).catch(()=>fallback),
    new Promise<T>(resolve=>{timer=setTimeout(()=>{controller.abort();resolve(fallback);},ms);}),
  ]);}finally{clearTimeout(timer!);controller.abort();}
}
export function jobHeartbeat(refresh:()=>Promise<boolean>,intervalMs=20_000){
  let lost=false,active=true,pending=false;
  const beat=async()=>{if(!active||pending)return;pending=true;
    try{if(!await refresh())lost=true;}catch{lost=true;}finally{pending=false;}};
  const timer=setInterval(()=>void beat(),intervalMs);timer.unref();
  return {assertOwned(){if(lost)throw Error("Import lease lost; reconcile before retry");},
    stop(){active=false;clearInterval(timer);}};
}
