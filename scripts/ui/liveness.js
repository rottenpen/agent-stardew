(() => {
  const expectedInstance = document.currentScript?.dataset.instance
  if (!expectedInstance) return

  let checking = false
  let blocked = false
  let replaced = false
  let overlay
  const show = message => {
    blocked = true
    if (!document.body) return
    if (!overlay) {
      overlay = document.createElement('div')
      overlay.id = 'stardew-connection-guard'
      overlay.setAttribute('role', 'alert')
      overlay.setAttribute('aria-live', 'assertive')
      overlay.innerHTML = '<div><strong>dsh 连接已中断</strong><p></p></div>'
      document.body.append(overlay)
    }
    overlay.querySelector('p').textContent = message
    overlay.hidden = false
  }
  const hide = () => {
    blocked = false
    if (overlay) overlay.hidden = true
  }
  const blockInput = event => {
    if (!blocked) return
    event.preventDefault()
    event.stopImmediatePropagation()
  }

  for (const event of ['beforeinput', 'keydown', 'paste', 'drop', 'submit']) document.addEventListener(event, blockInput, true)

  async function check() {
    if (checking || replaced) return
    checking = true
    try {
      const response = await fetch('/stardew-connect/instance', {
        cache: 'no-store',
        credentials: 'same-origin',
        signal: AbortSignal.timeout(1500),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const current = await response.json()
      if (current.id !== expectedInstance) {
        replaced = true
        show('服务已重启，正在重新连接…')
        location.replace('/')
        return
      }
      hide()
    } catch {
      show('服务恢复后将自动重新连接。当前输入不会发送。')
    } finally {
      checking = false
    }
  }

  addEventListener('focus', check)
  addEventListener('online', check)
  addEventListener('pageshow', check)
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void check() })
  setInterval(check, 1000)
  void check()
})()
