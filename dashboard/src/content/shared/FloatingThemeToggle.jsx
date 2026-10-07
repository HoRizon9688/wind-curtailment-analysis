import React,{useEffect,useState} from 'react';
import './floating-theme-toggle.css';

/** Observe the native runtime's resolved scheme; never override its theme tokens. */
export function FloatingThemeToggle({onAppearanceChange}){
 const [dark,setDark]=useState(()=>document.documentElement.dataset.colorScheme==='dark');
 useEffect(()=>{
  const root=document.documentElement,sync=()=>setDark(root.dataset.colorScheme==='dark');
  const observer=new MutationObserver(sync);observer.observe(root,{attributes:true,attributeFilter:['data-color-scheme']});sync();
  return()=>observer.disconnect();
 },[]);
 const label=dark?'切换为浅色主题':'切换为深色主题';
 return <button type="button" className="wind-theme-toggle" aria-label={label} title={label}
  onClick={()=>onAppearanceChange(dark?'light':'dark')}>
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
   {dark?<><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/></>:<path d="M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13Z"/>}
  </svg>
 </button>;
}
