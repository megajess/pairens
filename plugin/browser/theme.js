// Theme picker: the same System / Light / Dark / Terminal menu as pairens.dev.
// Light, dark and terminal are saved; System clears the saved choice so the
// page follows the device's light/dark setting. This is a classic script
// loaded in <head> so a saved theme applies before the page paints.

(function () {
  var KEY = 'pairens.theme'
  var root = document.documentElement
  try {
    var saved = localStorage.getItem(KEY)
    if (saved === 'light' || saved === 'dark' || saved === 'terminal') root.dataset.theme = saved
  } catch (e) {}

  function wire() {
    var button = document.getElementById('theme-toggle')
    var menu = document.getElementById('theme-menu')
    var label = document.getElementById('theme-label')
    if (!button || !menu || !label) return
    var options = Array.prototype.slice.call(menu.querySelectorAll('.theme-option'))
    var names = { system: 'System', light: 'Light', dark: 'Dark', terminal: 'Terminal' }
    function current() { return root.dataset.theme || 'system' }
    function render() {
      var mode = current()
      label.textContent = names[mode]
      button.querySelectorAll('[data-icon]').forEach(function (icon) { icon.hidden = icon.dataset.icon !== mode })
      button.setAttribute('aria-label', 'Theme: ' + names[mode])
      options.forEach(function (o) { o.setAttribute('aria-checked', String(o.dataset.value === mode)) })
    }
    function open() {
      menu.hidden = false
      button.setAttribute('aria-expanded', 'true')
      var checked = options.filter(function (o) { return o.getAttribute('aria-checked') === 'true' })[0]
      ;(checked || options[0]).focus()
    }
    function close(returnFocus) {
      if (menu.hidden) return
      menu.hidden = true
      button.setAttribute('aria-expanded', 'false')
      if (returnFocus) button.focus()
    }
    button.addEventListener('click', function () { menu.hidden ? open() : close(true) })
    button.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open() }
    })
    options.forEach(function (o) {
      o.addEventListener('click', function () {
        var value = o.dataset.value
        try {
          if (value === 'system') localStorage.removeItem(KEY)
          else localStorage.setItem(KEY, value)
        } catch (e) {}
        if (value === 'system') delete root.dataset.theme
        else root.dataset.theme = value
        render()
        close(true)
      })
    })
    menu.addEventListener('keydown', function (e) {
      var i = options.indexOf(document.activeElement)
      if (e.key === 'ArrowDown') { e.preventDefault(); options[(i + 1) % options.length].focus() }
      else if (e.key === 'ArrowUp') { e.preventDefault(); options[(i - 1 + options.length) % options.length].focus() }
      else if (e.key === 'Home') { e.preventDefault(); options[0].focus() }
      else if (e.key === 'End') { e.preventDefault(); options[options.length - 1].focus() }
      else if (e.key === 'Escape') { e.preventDefault(); close(true) }
      else if (e.key === 'Tab') { close(false) }
    })
    document.addEventListener('click', function (e) {
      if (!menu.hidden && !e.target.closest('.theme-picker')) close(false)
    })
    render()
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire)
  else wire()
})()
