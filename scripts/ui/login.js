const form = document.querySelector('#connect-form')
const input = document.querySelector('#launch-link')
const feedback = document.querySelector('#feedback')
const button = document.querySelector('#connect')
const showError = text => { feedback.textContent = text; input.setAttribute('aria-invalid', 'true') }
if (document.body.dataset.state === 'expired') showError('登录链接无效或已过期，请获取当前服务的新链接。')
// 不把粘贴的凭据写入历史记录或浏览器存储。
if (location.search) history.replaceState(null, '', location.pathname)
input.placeholder = `${location.origin}/?token=…`
input.addEventListener('input', () => { feedback.textContent = ''; input.removeAttribute('aria-invalid') })
form.addEventListener('submit', async event => {
  event.preventDefault()
  if (button.disabled) return
  const link = input.value.trim()
  if (!link) { showError('请先粘贴完整的启动链接。'); input.focus(); return }
  button.disabled = true; button.textContent = '正在连接…'; form.setAttribute('aria-busy', 'true')
  try {
    const response = await fetch('/stardew-connect/login', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ link }), signal: AbortSignal.timeout(8000) })
    const result = await response.json()
    if (!response.ok) { showError(result.error ?? '连接失败，请重试。'); input.focus(); return }
    input.value = ''
    // 再确认浏览器接受了 Cookie，避免禁用 Cookie 时在登录页和首页之间循环。
    const check = await fetch('/', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(8000) })
    if (!check.ok) { showError('浏览器未保留登录状态，请允许此站点使用 Cookie 后重试。'); return }
    location.replace('/')
  } catch { showError('暂时连不上 dsh。请确认启动终端仍在运行，再重试。') }
  finally { button.disabled = false; button.innerHTML = '连接工作区 <span aria-hidden="true">→</span>'; form.removeAttribute('aria-busy') }
})
document.querySelector('#copy-command').addEventListener('click', async event => {
  const copyButton = event.currentTarget
  try { await navigator.clipboard.writeText('pnpm open --print'); copyButton.textContent = '已复制' }
  catch { feedback.textContent = '未能复制，请手动复制上方命令。' }
})
