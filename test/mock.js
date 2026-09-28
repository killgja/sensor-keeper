// Mock mirror node + faucet + ntfy/discord for offline tests
const http=require('http');
const st={bal:{'0.0.111':25e8,'0.0.222':500e8},faucetCode:200,calls:[],alerts:[]};
const hbTx=(id,ageSec)=>Array.from({length:25},(_,i)=>({transaction_id:`${id}-${1}-${i}`,consensus_timestamp:String(Date.now()/1000-ageSec-41*i),charged_tx_fee:310000,result:'SUCCESS'}));
http.createServer((q,r)=>{let b='';q.on('data',d=>b+=d);q.on('end',()=>{
 const u=new URL(q.url,'http://x');
 const send=(c,o)=>{r.writeHead(c,{'content-type':'application/json'});r.end(JSON.stringify(o));};
 if(u.pathname=='/ctl'){Object.assign(st,JSON.parse(b||'{}'));return send(200,st);}
 let m=u.pathname.match(/^\/api\/v1\/accounts\/(0\.0\.\d+)$/);
 if(m){return st.bal[m[1]]==null?send(404,{_status:{messages:[{message:'Not found'}]}}):send(200,{balance:{balance:st.bal[m[1]]},deleted:false});}
 if(u.pathname=='/api/v1/transactions'){const id=u.searchParams.get('account.id');return send(200,{transactions:hbTx(id,id=='0.0.222'?3600:20)});}
 if(u.pathname=='/faucet'){st.calls.push({auth:q.headers.authorization,body:JSON.parse(b)});
   if(st.faucetCode==200){const x=JSON.parse(b);st.bal[x.address]+=x.amount*1e8;return send(200,{amount:x.amount,transactionId:'0.0.2@123.456',remainingAllowance:100-x.amount});}
   return send(st.faucetCode,{message:'nope'});}
 if(u.pathname.startsWith('/ntfy/')||u.pathname=='/discord'){st.alerts.push({path:u.pathname,title:q.headers.title,body:b});return send(200,{});}
 if(u.pathname=='/dev/status.json')return send(200,{gnss:{status:'green',desc:'ok'},mlat:{status:'red',desc:'MLAT server connection lost'},network:{status:'unknown'}});
 send(404,{});
});}).listen(8799,()=>console.log('mock up'));
