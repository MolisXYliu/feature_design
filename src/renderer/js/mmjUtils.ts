import './mmj.js'

export function initMMJ(){
  if (window.mmjTrack && !window.mmjStart){
    window.mmjStart = true
    window.mmjTrack.setConfig({
      env: 'prodOA',
      appName: 'CMBDevClaw',
      productCode: 'LA64.06',
      userId: localStorage.getItem('localIp') || '游客',
      org: localStorage.getItem('version') || '',
    })
  }
}

export const updateMMJUserInfo=()=>{
  if ( window.mmjTrack && window.mmjTrack.updateUserInfo){
    window.mmjTrack.updateUserInfo({
      userId: localStorage.getItem('localIp'),
      org: localStorage.getItem('version')
    })
  }
}


export const insertDomLog=({id, text})=>{
  if ( window.mmjTrack && window.mmjTrack.updateMMJDomClick && id && text){
    window.mmjTrack.updateMMJDomClick({id, text})
  }
}
export const insertLog=(text)=>{
  if ( window.mmjTrack && window.mmjTrack.sendLogToMMJ && text){
    window.mmjTrack.sendLogToMMJ(text)
  }
}
