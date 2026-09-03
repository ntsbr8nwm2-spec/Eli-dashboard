import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabase=createClient(
  'https://vihtghmtnnozflnmecis.supabase.co',
  'sb_publishable_ApNLrNRP70DP-xD0evgTJg_a-jj8mPp'
);

function addStyles(){
  if(document.getElementById('smsNotificationStyles'))return;
  const style=document.createElement('style');
  style.id='smsNotificationStyles';
  style.textContent=`
    .smsBox{margin:18px 0 15px;padding:16px;border:1px solid #dce5ee;border-radius:17px;background:#f8fbfe}
    .smsTop{display:flex;align-items:flex-start;justify-content:space-between;gap:14px}
    .smsKicker{font-size:11px;font-weight:900;letter-spacing:.9px;color:#2a6b9e;margin-bottom:4px}
    .smsTitle{font-size:18px;font-weight:900;color:#182237}
    .smsSub{font-size:12px;line-height:1.4;color:#6f7d90;margin-top:4px;max-width:360px}
    .smsLabel{display:block;font-size:13px;font-weight:800;margin:14px 0 7px}
    .smsPhone{width:100%;border:1px solid #e2e8f0;border-radius:13px;padding:14px 13px;font-size:16px;background:#fff;color:#182237;outline:none}
    .smsPhone:focus{border-color:#4b90c6;box-shadow:0 0 0 3px rgba(55,127,182,.13)}
    .smsSave{width:100%;border:1px solid #d9e2eb;border-radius:13px;padding:13px 15px;background:#fff;color:#31546f;font-size:14px;font-weight:850;margin-top:10px}
    .smsSave:disabled{opacity:.55}
    .smsResult{display:none;margin-top:10px;border-radius:12px;padding:10px 11px;font-size:12px;line-height:1.4}
    .smsResult.show{display:block}.smsResult.good{background:#ecf9f2;color:#155d3b;border:1px solid #b9e4cb}.smsResult.bad{background:#fff0ef;color:#b42318;border:1px solid #f2c8c5}.smsResult.note{display:block;background:#fff8e6;color:#765b12;border:1px solid #ecdca9}
    .smsPrivacy{font-size:11px;line-height:1.4;color:#7a8798;margin-top:9px}
    .smsSwitch{position:relative;width:50px;height:29px;flex:0 0 auto;margin-top:2px}
    .smsSwitch input{position:absolute;opacity:0;width:1px!important;height:1px!important}
    .smsSlider{position:absolute;inset:0;background:#cbd5e1;border-radius:999px;transition:.18s}
    .smsSlider:before{content:"";position:absolute;width:23px;height:23px;left:3px;top:3px;border-radius:50%;background:#fff;box-shadow:0 1px 5px rgba(0,0,0,.22);transition:.18s}
    .smsSwitch input:checked + .smsSlider{background:#2b72aa}
    .smsSwitch input:checked + .smsSlider:before{transform:translateX(21px)}
  `;
  document.head.appendChild(style);
}

function formatPhone(value){
  const digits=String(value||'').replace(/\D/g,'');
  const local=digits.length===11&&digits.startsWith('1')?digits.slice(1):digits;
  if(local.length===10)return `(${local.slice(0,3)}) ${local.slice(3,6)}-${local.slice(6)}`;
  return value||'';
}

function result(text,type='good'){
  const box=document.getElementById('smsResult');
  if(!box)return;
  box.textContent=text;
  box.className=`smsResult show ${type}`;
}

async function providerStatus(){
  try{
    const {data,error}=await supabase.functions.invoke('notification-status',{body:{}});
    if(error)return false;
    return Boolean(data?.smsConfigured);
  }catch{return false;}
}

async function loadSettings(){
  const enabled=document.getElementById('smsEnabled');
  const phone=document.getElementById('smsPhone');
  if(!enabled||!phone)return;
  const {data,error}=await supabase.rpc('get_my_notification_settings');
  if(!error){
    const row=Array.isArray(data)?data[0]:data;
    enabled.checked=Boolean(row?.sms_enabled);
    phone.value=formatPhone(row?.phone||'');
  }
  const configured=await providerStatus();
  if(!configured){
    result('Notification settings can be saved now. Actual SMS delivery still needs the texting provider connected.','note');
  }
}

async function saveSettings(){
  const enabled=document.getElementById('smsEnabled');
  const phone=document.getElementById('smsPhone');
  const button=document.getElementById('smsSave');
  if(!enabled||!phone||!button)return;
  button.disabled=true;
  const old=button.textContent;
  button.textContent='Saving…';
  try{
    const {data,error}=await supabase.rpc('set_my_notification_settings',{
      p_phone:phone.value.trim(),
      p_sms_enabled:enabled.checked
    });
    if(error)throw error;
    const row=Array.isArray(data)?data[0]:data;
    enabled.checked=Boolean(row?.sms_enabled);
    phone.value=formatPhone(row?.phone||phone.value);
    const configured=await providerStatus();
    if(enabled.checked&&configured) result('SMS grade alerts are on. You’ll get one text when a grade changes.','good');
    else if(enabled.checked) result('SMS preference saved. The texting provider still needs to be connected before messages can send.','note');
    else result('SMS grade alerts are off.','good');
  }catch(e){
    result(e?.message||'Could not save notification settings.','bad');
  }finally{
    button.disabled=false;
    button.textContent=old;
  }
}

function inject(){
  const hub=document.getElementById('hub');
  const addStudent=document.getElementById('addStudent');
  if(!hub||!addStudent||document.getElementById('smsNotifications'))return;
  addStyles();
  const box=document.createElement('div');
  box.id='smsNotifications';
  box.className='smsBox';
  box.innerHTML=`
    <div class="smsTop">
      <div>
        <div class="smsKicker">NOTIFICATIONS</div>
        <div class="smsTitle">SMS grade alerts</div>
        <div class="smsSub">Get one text when one of your students has a grade change.</div>
      </div>
      <label class="smsSwitch" aria-label="Turn SMS grade alerts on or off">
        <input id="smsEnabled" type="checkbox">
        <span class="smsSlider"></span>
      </label>
    </div>
    <label class="smsLabel" for="smsPhone">Mobile number</label>
    <input class="smsPhone" id="smsPhone" type="tel" inputmode="tel" autocomplete="tel" placeholder="(954) 555-1234">
    <button class="smsSave" id="smsSave" type="button">Save notification settings</button>
    <div class="smsPrivacy">Texts contain only a change notice and dashboard link. The actual grade stays inside the signed-in dashboard.</div>
    <div class="smsResult" id="smsResult"></div>
  `;
  hub.insertBefore(box,addStudent);
  document.getElementById('smsSave')?.addEventListener('click',saveSettings);
  loadSettings();
}

async function boot(){
  const {data:{session}}=await supabase.auth.getSession();
  if(session?.user)inject();
  supabase.auth.onAuthStateChange((_event,next)=>{
    if(next?.user)setTimeout(inject,0);
  });
}

boot();
