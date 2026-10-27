const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

const state = {
  scan: null,
  selected: new Set(),
  allowBurn: false,
  build: null,
  audit: null,
  provider: null,
  providerName: null,
}

const $ = (id) => document.getElementById(id)

function h(tag, attrs = {}, children = []) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue
    if (key === 'class') node.className = value
    else if (key === 'html') node.innerHTML = value
    else node.setAttribute(key, String(value))
  }
  for (const child of [].concat(children)) {
    if (child == null || child === false) continue
    node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return node
}

function sol(lamports) {
  const abs = Math.abs(Math.trunc(Number(lamports) || 0))
  const whole = Math.floor(abs / 1_000_000_000)
  const frac = String(abs % 1_000_000_000).padStart(9, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : String(whole)
}

function usd(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—'
  const n = Number(value)
  if (n > 0 && n < 0.005) return '<$0.01'
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

function short(value, lead = 4, tail = 4) {
  const text = String(value ?? '')
  if (text.length <= lead + tail + 1) return text
  return `${text.slice(0, lead)}…${text.slice(-tail)}`
}

function parseAddresses(raw) {
  return [...new Set(String(raw).split(/[\s,]+/).map((part) => part.trim()).filter(Boolean))]
}

function setTab(name) {
  const scan = name !== 'radar'
  $('tab-scan').setAttribute('aria-selected', String(scan))
  $('tab-radar').setAttribute('aria-selected', String(!scan))
  $('tab-scan').tabIndex = scan ? 0 : -1
  $('tab-radar').tabIndex = scan ? -1 : 0
  $('panel-scan').hidden = !scan
  $('panel-radar').hidden = scan
  history.replaceState(null, '', scan ? '#scan' : '#radar')
}

function status(id, message, bad = false) {
  const node = $(id)
  node.textContent = message || ''
  node.classList.toggle('bad', bad)
}

function loading(target) {
  target.replaceChildren(h('div', { class: 'card' }, [
    h('div', { class: 'skeleton' }),
    h('div', { class: 'skeleton' }),
    h('div', { class: 'skeleton' }),
  ]))
}

async function readJson(response) {
  const body = await response.json().catch(() => ({}))
  if (!response.ok || body.ok === false) {
    const detail = Array.isArray(body.details?.accounts)
      ? ` ${body.details.accounts.map((item) => item.reason).join(' ')}`
      : ''
    throw new Error((body.error || `Request failed (${response.status})`) + detail)
  }
  return body
}

function sum(wallets, key) {
  return wallets.reduce((total, wallet) => total + (wallet[key] || 0), 0)
}

async function scan(raw) {
  const wallets = parseAddresses(raw)
  if (wallets.length === 0 || wallets.some((wallet) => !BASE58.test(wallet))) {
    status('scan-status', 'Enter one or more valid Solana addresses.', true)
    return
  }
  const button = $('scan-button')
  button.disabled = true
  button.textContent = 'Scanning mainnet…'
  status('scan-status', 'Reading balances, token accounts, creator vaults, and recent programs.')
  loading($('scan-output'))
  try {
    const query = wallets.length > 1 ? `?wallets=${encodeURIComponent(wallets.slice(1).join(','))}` : ''
    const body = await readJson(await fetch(`/api/scan/${wallets[0]}${query}`))
    state.scan = body
    state.selected = new Set(body.wallets.flatMap((wallet) => wallet.accounts.filter((account) => account.closeable).map((account) => account.pubkey)))
    state.allowBurn = false
    state.build = null
    renderScan(body)
    status('scan-status', body.errors?.length ? body.errors.map((error) => error.error).join(' ') : '')
    try { localStorage.setItem('solana-reclaim:wallet', wallets.join(',')) } catch { /* private mode */ }
  } catch (err) {
    $('scan-output').replaceChildren(h('div', { class: 'card empty' }, [
      h('strong', {}, 'Scan failed'),
      h('p', {}, err instanceof Error ? err.message : 'Unknown error'),
      h('button', { class: 'ghost', type: 'button', id: 'retry-scan' }, 'Retry'),
    ]))
    $('retry-scan')?.addEventListener('click', () => scan(raw))
    status('scan-status', '', true)
  } finally {
    button.disabled = false
    button.textContent = 'Scan'
  }
}

function renderScan(body) {
  const wallets = body.wallets || []
  const reclaimLamports = sum(wallets, 'reclaimableLamports')
  const reclaimUsd = wallets.every((wallet) => wallet.reclaimableUsd == null)
    ? null
    : wallets.reduce((total, wallet) => total + (wallet.reclaimableUsd || 0), 0)
  const price = body.solPriceUsd
  const output = $('scan-output')
  output.replaceChildren()

  const hero = h('article', { class: 'card hero-card' }, [
    h('p', { class: 'eyebrow' }, 'Reclaimable rent'),
    h('p', { class: 'hero-value' }, [sol(reclaimLamports), ' ', h('span', {}, 'SOL')]),
    h('p', { class: 'subline' }, `${usd(reclaimUsd)} at ${price == null ? 'an unavailable USD quote' : `${usd(price)} / SOL`}`),
    h('p', { class: 'subline', id: 'selection-line' }, selectionLine(wallets)),
  ])

  const stats = h('div', { class: 'stat-grid' }, [
    stat(wallets.reduce((n, w) => n + w.summary.emptySpl, 0), 'Empty SPL'),
    stat(wallets.reduce((n, w) => n + w.summary.emptyToken2022, 0), 'Empty Token-2022'),
    stat(wallets.reduce((n, w) => n + w.summary.active, 0), 'Active holdings'),
    stat(wallets.reduce((n, w) => n + w.summary.locked, 0), 'Frozen or blocked'),
  ])

  const actions = h('div', { class: 'actions' }, [
    actionButton('build-tx', 'Build unsigned reclaim batch (0% fee)', true),
    actionButton('sign-tx', 'Connect Phantom / Solflare to sign', false),
    actionButton('share-card', 'Share receipt card on X', false),
  ])

  const left = h('div', { class: 'stack' }, [hero, stats, actions])
  const right = h('div', { class: 'stack' })
  for (const wallet of wallets) right.append(protocolCard(wallet), accountCard(wallet))
  if (wallets.length === 0) {
    left.append(h('div', { class: 'card empty' }, 'No wallet data came back.'))
  }
  output.append(h('div', { class: 'scan-layout' }, [left, right]))
  $('build-tx').addEventListener('click', () => buildTx(false))
  $('sign-tx').addEventListener('click', () => buildTx(true))
  $('share-card').addEventListener('click', () => openShare())
}

function selectionLine(wallets) {
  const batches = wallets.reduce((total, wallet) => total + wallet.summary.estimatedCloseTransactions, 0)
  return `${state.selected.size} account${state.selected.size === 1 ? '' : 's'} selected · about ${batches} unsigned batch${batches === 1 ? '' : 'es'} · 0% protocol fee`
}

function stat(value, label) {
  return h('div', { class: 'stat' }, [h('b', {}, String(value)), h('span', {}, label)])
}

function actionButton(id, label, primary) {
  return h('button', { type: 'button', id, class: primary ? 'primary' : 'ghost' }, label)
}

function protocolCard(wallet) {
  const fees = wallet.activity.creatorFees
  const tables = wallet.activity.lookupTables
  const programs = wallet.activity.programs.slice(0, 6).map((program) => (
    h('div', { class: 'meta' }, `${program.hits}× ${program.name}`)
  ))
  return h('article', { class: 'card stack' }, [
    h('p', { class: 'eyebrow' }, short(wallet.address, 6, 6)),
    h('p', {}, `Native ${wallet.nativeSol} SOL (${usd(wallet.nativeUsd)})`),
    h('p', {}, fees.pumpCreatorVault.claimableLamports > 0
      ? `pump.fun creator vault: ${fees.pumpCreatorVault.claimableSol} SOL claimable. This is not in the close batch.`
      : 'No direct pump.fun creator-vault balance.'),
    h('p', {}, fees.pumpSwapWsolAta.exists && fees.pumpSwapWsolAta.uiAmount !== '0'
      ? `PumpSwap creator fees: ${fees.pumpSwapWsolAta.uiAmount} wSOL. Claim on the protocol; do not close that account.`
      : 'No PumpSwap wSOL creator-fee balance on the direct vault.'),
    h('p', {}, tables.status === 'unavailable'
      ? 'Lookup tables: this RPC did not serve getProgramAccounts.'
      : tables.tables.length
        ? `${tables.tables.length} lookup table${tables.tables.length === 1 ? '' : 's'}, ${tables.reclaimableSol} SOL closeable after cooldown.`
        : 'No address lookup tables owned by this wallet.'),
    programs.length ? h('div', {}, [h('p', { class: 'eyebrow' }, 'Recent programs'), ...programs]) : null,
    wallet.warnings.length ? h('div', { class: 'warning' }, wallet.warnings.join(' ')) : null,
  ])
}

function accountCard(wallet) {
  const card = h('article', { class: 'card' })
  const head = h('div', { class: 'ledger-head' }, [
    h('span'),
    h('span', {}, 'Account'),
    h('span', {}, 'Rent'),
  ])
  card.append(
    h('p', { class: 'eyebrow' }, `${wallet.summary.tokenAccounts} token accounts`),
    head,
  )
  if (wallet.accounts.length === 0) {
    card.append(h('p', { class: 'empty' }, 'No SPL or Token-2022 accounts. Nothing to reclaim.'))
    return card
  }
  const dust = wallet.accounts.filter((account) => account.category === 'dust')
  if (dust.length) {
    const burn = h('label', { class: 'meta' }, [
      (() => {
        const box = h('input', { type: 'checkbox' })
        box.checked = state.allowBurn
        box.addEventListener('change', () => {
          state.allowBurn = box.checked
          if (!box.checked) {
            for (const account of dust) state.selected.delete(account.pubkey)
          }
          renderScan(state.scan)
        })
        return box
      })(),
      ' Allow burn of unprotected dust (irreversible, off by default)',
    ])
    card.append(burn)
  }
  for (const account of wallet.accounts) card.append(accountRow(account))
  return card
}

function accountRow(account) {
  const disabled = account.category === 'locked' || account.category === 'active' || (account.category === 'dust' && !state.allowBurn)
  const box = h('input', { type: 'checkbox' })
  box.checked = state.selected.has(account.pubkey)
  box.disabled = disabled
  box.addEventListener('change', () => {
    if (box.checked) state.selected.add(account.pubkey)
    else state.selected.delete(account.pubkey)
    const line = $('selection-line')
    if (line && state.scan?.wallets) line.textContent = selectionLine(state.scan.wallets)
  })
  const rent = account.reclaimLamports || account.potentialRentLamports || account.stuckLamports
  return h('div', { class: `row ${account.category}` }, [
    box,
    h('div', {}, [
      h('div', { class: 'mint' }, `${account.mintLabel ? account.mintLabel + ' · ' : ''}${short(account.mint)}`),
      h('div', { class: 'meta' }, `${account.program} · ${account.uiAmountString} · ${short(account.pubkey)} · ${account.reasons[0] || account.category}`),
    ]),
    h('div', { class: 'lamports' }, `${sol(rent)} SOL`),
  ])
}

async function buildTx(signAfter) {
  if (!state.scan?.wallets?.length) return
  const selected = [...state.selected]
  if (selected.length === 0) {
    status('scan-status', 'Select at least one closeable account.', true)
    return
  }
  const dustSelected = state.scan.wallets.some((wallet) => wallet.accounts.some((account) => (
    selected.includes(account.pubkey) && account.category === 'dust'
  )))
  if (dustSelected && !window.confirm('Burn the selected unprotected dust? This destroys those tokens and cannot be undone.')) return
  status('scan-status', 'Building an unsigned batch. solana-reclaim adds no fee transfer.')
  try {
    const jobs = state.scan.wallets.flatMap((wallet) => {
      const accounts = wallet.accounts.filter((account) => selected.includes(account.pubkey))
      if (accounts.length === 0) return []
      return [{
        wallet: wallet.address,
        accounts: accounts.map((account) => account.pubkey),
        allowBurn: accounts.some((account) => account.category === 'dust'),
      }]
    })
    const builds = []
    for (const job of jobs) {
      builds.push(await readJson(await fetch('/api/build-reclaim-tx', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...job, priorityMicroLamports: 20_000 }),
      })))
    }
    const built = {
      protocolFeeLamports: 0,
      recentBlockhash: builds.at(-1)?.recentBlockhash || '',
      totals: {
        transactions: builds.reduce((total, item) => total + item.totals.transactions, 0),
        closes: builds.reduce((total, item) => total + item.totals.closes, 0),
        burns: builds.reduce((total, item) => total + item.totals.burns, 0),
        reclaimSol: sol(builds.reduce((total, item) => total + item.totals.reclaimLamports, 0)),
      },
      transactions: builds.flatMap((item) => item.transactions.map((tx) => ({ ...tx, wallet: item.wallet }))),
    }
    state.build = built
    showBuild(built)
    status('scan-status', `${built.totals.transactions} unsigned transaction(s), ${built.totals.reclaimSol} SOL, protocol fee 0 lamports.`)
    if (signAfter) await signBuild(built)
  } catch (err) {
    status('scan-status', err instanceof Error ? err.message : 'Could not build the batch.', true)
  }
}

function showBuild(built) {
  const body = $('tx-body')
  body.replaceChildren(
    h('p', {}, `${built.totals.transactions} transaction(s) · ${built.totals.closes} close · ${built.totals.burns} burn · ${built.totals.reclaimSol} SOL · protocol fee 0`),
    h('p', { class: 'fine' }, `Blockhash ${built.recentBlockhash || 'n/a'}. Sign within about a minute. Priority fee is a validator tip, not a protocol fee.`),
    ...built.transactions.map((tx, index) => h('label', {}, [
      `Transaction ${index + 1} · ${tx.kind} · ${tx.byteLength} bytes`,
      (() => {
        const area = h('textarea', { readonly: 'true', rows: '5' })
        area.value = tx.base64
        return area
      })(),
    ])),
    h('div', { class: 'dialog-actions' }, [
      (() => {
        const button = h('button', { type: 'button', class: 'ghost' }, 'Copy first transaction')
        button.addEventListener('click', () => navigator.clipboard.writeText(built.transactions[0]?.base64 || ''))
        return button
      })(),
    ]),
  )
  $('tx-dialog').showModal()
}

function providers() {
  const list = []
  const phantom = window.phantom?.solana || (window.solana?.isPhantom ? window.solana : null)
  if (phantom) list.push({ name: 'Phantom', provider: phantom })
  if (window.solflare?.isSolflare) list.push({ name: 'Solflare', provider: window.solflare })
  if (window.backpack) list.push({ name: 'Backpack', provider: window.backpack })
  return list
}

async function signBuild(built) {
  const available = providers()
  if (available.length === 0) {
    status('scan-status', 'No Phantom, Solflare, or Backpack provider was detected. Copy the unsigned transaction or install a wallet.', true)
    return
  }
  const choice = available[0]
  try {
    const response = await choice.provider.connect()
    const connected = response?.publicKey?.toString?.() || choice.provider.publicKey?.toString?.()
    const web3 = await import('https://esm.sh/@solana/web3.js@1.99.0')
    const signatures = []
    for (const tx of built.transactions) {
      if (tx.wallet && connected !== tx.wallet) {
        status('scan-status', `Connected ${short(connected)} but ${short(tx.wallet)} owns this batch. Switch accounts to sign it.`, true)
        continue
      }
      const bytes = Uint8Array.from(atob(tx.base64), (char) => char.charCodeAt(0))
      const transaction = tx.format === 'versioned'
        ? web3.VersionedTransaction.deserialize(bytes)
        : web3.Transaction.from(bytes)
      const sent = choice.provider.signAndSendTransaction
        ? await choice.provider.signAndSendTransaction(transaction)
        : null
      const signature = sent?.signature || sent
      if (typeof signature === 'string') signatures.push(signature)
    }
    if (signatures.length === 0) {
      status('scan-status', 'The wallet did not return a signature. The unsigned batch is still in the dialog.', true)
      return
    }
    const links = signatures.map((signature) => h('a', {
      href: `https://solscan.io/tx/${signature}`,
      target: '_blank',
      rel: 'noopener',
      class: 'sig',
    }, signature))
    $('tx-body').append(h('div', {}, [h('p', {}, 'Submitted'), ...links]))
    status('scan-status', `Submitted ${signatures.length} transaction(s).`)
  } catch (err) {
    status('scan-status', err instanceof Error ? err.message : 'Wallet signing was cancelled.', true)
  }
}

function openShare() {
  const wallets = state.scan?.wallets || []
  if (!wallets.length) return
  const lamports = sum(wallets, 'reclaimableLamports')
  const reclaimUsd = wallets.every((wallet) => wallet.reclaimableUsd == null)
    ? null
    : wallets.reduce((total, wallet) => total + (wallet.reclaimableUsd || 0), 0)
  const empty = wallets.reduce((total, wallet) => total + wallet.summary.reclaimableAccounts, 0)
  const canvas = $('share-canvas')
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height)
  gradient.addColorStop(0, '#10140c')
  gradient.addColorStop(1, '#071018')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.strokeStyle = 'rgba(214,255,74,0.35)'
  ctx.strokeRect(28, 28, canvas.width - 56, canvas.height - 56)
  ctx.fillStyle = '#3ddec4'
  ctx.font = '500 22px "IBM Plex Mono", monospace'
  ctx.fillText('SOLANA-RECLAIM  ·  0% PROTOCOL FEE', 64, 100)
  ctx.fillStyle = '#93a0b4'
  ctx.font = '500 28px Outfit, sans-serif'
  ctx.fillText('Reclaimable rent', 64, 190)
  ctx.fillStyle = '#d6ff4a'
  ctx.font = '800 92px Syne, sans-serif'
  ctx.fillText(`${sol(lamports)} SOL`, 64, 300)
  ctx.fillStyle = '#e7edf6'
  ctx.font = '500 36px Outfit, sans-serif'
  ctx.fillText(reclaimUsd == null ? 'USD quote unavailable' : `About ${usd(reclaimUsd)}`, 64, 370)
  ctx.fillStyle = '#93a0b4'
  ctx.font = '400 28px Outfit, sans-serif'
  ctx.fillText(`${empty} empty token account${empty === 1 ? '' : 's'}  ·  unsigned until you sign`, 64, 450)
  ctx.fillText(wallets.length === 1 ? short(wallets[0].address, 6, 6) : `${wallets.length} wallets`, 64, 510)

  const text = [
    'Scanned with solana-reclaim (read-only, 0% protocol fee).',
    `${sol(lamports)} SOL reclaimable rent across ${empty} empty token account${empty === 1 ? '' : 's'}${reclaimUsd == null ? '' : ` (${usd(reclaimUsd)})`}.`,
    wallets.length === 1 ? `Wallet ${wallets[0].address}` : `${wallets.length} wallets scanned.`,
  ].join('\n')
  $('x-share').href = `https://x.com/intent/post?text=${encodeURIComponent(text)}`
  $('share-dialog').showModal()
}

async function audit(raw) {
  const mint = raw.trim()
  if (!BASE58.test(mint)) {
    status('audit-status', 'Enter a valid mint address.', true)
    return
  }
  const button = $('audit-button')
  button.disabled = true
  button.textContent = 'Reading mint…'
  status('audit-status', 'Checking authorities, extensions, and the largest holders.')
  loading($('radar-output'))
  try {
    const body = await readJson(await fetch(`/api/audit/${mint}`))
    state.audit = body
    renderAudit(body)
    status('audit-status', '')
  } catch (err) {
    $('radar-output').replaceChildren(h('div', { class: 'card empty' }, err instanceof Error ? err.message : 'Audit failed'))
    status('audit-status', '', true)
  } finally {
    button.disabled = false
    button.textContent = 'Audit'
  }
}

function renderAudit(report) {
  const score = report.score.composite
  const color = score >= 85 ? '#d6ff4a' : score >= 65 ? '#ffb020' : '#ff5d73'
  const radius = 52
  const circ = 2 * Math.PI * radius
  const ring = h('svg', { class: 'ring', viewBox: '0 0 120 120' })
  ring.innerHTML = `
    <circle cx="60" cy="60" r="${radius}" fill="none" stroke="#232833" stroke-width="10"></circle>
    <circle cx="60" cy="60" r="${radius}" fill="none" stroke="${color}" stroke-width="10"
      stroke-linecap="round" stroke-dasharray="${circ}" stroke-dashoffset="${circ * (1 - score / 100)}"
      transform="rotate(-90 60 60)"></circle>
    <text x="60" y="68" text-anchor="middle">${score}</text>`
  const badges = h('div', {}, report.score.badges.map((badge) => h('span', { class: `pill ${badge.tone === 'bad' ? 'bad' : badge.tone === 'warn' ? 'warn' : badge.tone === 'good' ? 'good' : 'info'}` }, badge.label)))
  const left = h('article', { class: 'card' }, [
    h('div', { class: 'score-wrap' }, [
      ring,
      h('div', {}, [
        h('p', { class: 'eyebrow' }, report.symbol || 'Unknown symbol'),
        h('p', { class: 'band' }, report.score.bandLabel),
        h('p', { class: 'meta' }, report.name || 'No on-chain name'),
        badges,
      ]),
    ]),
    h('p', {}, `${report.program} · supply ${report.supplyUi} · decimals ${report.decimals}`),
    h('p', {}, `Mint authority: ${report.mintAuthority || 'revoked'}`),
    h('p', {}, `Freeze authority: ${report.freezeAuthority || 'revoked'}`),
    h('p', { class: 'meta' }, report.mint),
  ])
  const conc = report.concentration
  const bars = h('div', { class: 'bars' }, [
    meter('Top 1', conc.circulatingTop1Pct),
    meter('Top 5', conc.circulatingTop5Pct),
    meter('Top 10', conc.circulatingTop10Pct),
    meter('LP / vault', conc.lpSharePct),
  ])
  const holders = (conc.holders || []).slice(0, 10).map((holder) => h('div', { class: 'bar-row' }, [
    h('span', { class: 'holder' }, `#${holder.rank} ${short(holder.owner || holder.tokenAccount)}`),
    h('div', { class: holder.excluded ? 'bar excluded' : 'bar' }, [
      (() => {
        const fill = h('i')
        fill.style.width = `${Math.max(0, Math.min(100, holder.supplyPct || 0))}%`
        return fill
      })(),
    ]),
    h('span', { class: 'holder' }, holder.supplyPct == null ? '—' : `${holder.supplyPct.toFixed(1)}%`),
  ]))
  const extensions = report.extensions.length
    ? report.extensions.map((item) => h('p', {}, [h('span', { class: `pill ${item.risk === 'danger' ? 'bad' : item.risk === 'warn' ? 'warn' : 'info'}` }, item.name), item.summary]))
    : [h('p', { class: 'meta' }, 'No Token-2022 extensions on this mint.')]
  const breakdown = h('ul', { class: 'breakdown' }, report.score.breakdown.map((item) => h('li', {}, [
    h('span', {}, item.label),
    h('span', { class: item.delta === 0 ? 'delta zero' : 'delta' }, item.delta === 0 ? 'note' : String(item.delta)),
  ])))
  const right = h('div', { class: 'stack' }, [
    h('article', { class: 'card' }, [
      h('p', { class: 'eyebrow' }, 'Holder concentration'),
      bars,
      h('p', { class: 'fine' }, conc.note),
      ...holders,
    ]),
    h('article', { class: 'card' }, [
      h('p', { class: 'eyebrow' }, 'Extensions'),
      ...extensions,
      h('details', {}, [h('summary', {}, 'How the score is built'), h('p', {}, report.score.summary)]),
      breakdown,
    ]),
  ])
  if (report.warnings?.length) right.append(h('div', { class: 'warning' }, report.warnings.join(' ')))
  $('radar-output').replaceChildren(h('div', { class: 'radar-layout' }, [left, right]))
}

function meter(label, value) {
  const width = value == null ? 0 : Math.max(0, Math.min(100, value))
  const fill = h('i')
  fill.style.width = `${width}%`
  return h('div', { class: 'bar-row' }, [
    h('span', {}, label),
    h('div', { class: 'bar' }, [fill]),
    h('span', {}, value == null ? '—' : `${value.toFixed(1)}%`),
  ])
}

function boot() {
  $('tab-scan').addEventListener('click', () => setTab('scan'))
  $('tab-radar').addEventListener('click', () => setTab('radar'))
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
    if (document.activeElement?.getAttribute('role') !== 'tab') return
    setTab(event.key === 'ArrowRight' ? 'radar' : 'scan')
    ;(event.key === 'ArrowRight' ? $('tab-radar') : $('tab-scan')).focus()
  })
  $('scan-form').addEventListener('submit', (event) => {
    event.preventDefault()
    scan($('wallet-input').value)
  })
  $('audit-form').addEventListener('submit', (event) => {
    event.preventDefault()
    audit($('mint-input').value)
  })
  document.querySelectorAll('[data-wallet]').forEach((button) => {
    button.addEventListener('click', () => {
      $('wallet-input').value = button.getAttribute('data-wallet')
      scan(button.getAttribute('data-wallet'))
    })
  })
  document.querySelectorAll('[data-mint]').forEach((button) => {
    button.addEventListener('click', () => {
      setTab('radar')
      $('mint-input').value = button.getAttribute('data-mint')
      audit(button.getAttribute('data-mint'))
    })
  })
  $('download-card').addEventListener('click', () => {
    const link = document.createElement('a')
    link.href = $('share-canvas').toDataURL('image/png')
    link.download = 'solana-reclaim-receipt.png'
    link.click()
  })
  $('scan-output').append(h('div', { class: 'card empty' }, 'Paste a wallet above. The first scan only reads mainnet — it does not connect a wallet or build a transaction.'))
  $('radar-output').append(h('div', { class: 'card empty' }, 'Paste a mint, or try USDC, BONK, or PYUSD. Authorities and extensions are read from the mint account.'))
  if (location.hash === '#radar') setTab('radar')
  try {
    const saved = localStorage.getItem('solana-reclaim:wallet')
    if (saved) $('wallet-input').value = saved
  } catch { /* ignore */ }
  fetch('/api/health').then((response) => response.json()).then((body) => {
    const node = $('api-status')
    node.textContent = body.ok ? `API ${body.version}` : 'API error'
    node.classList.add(body.ok ? 'ok' : 'bad')
  }).catch(() => {
    $('api-status').textContent = 'API unreachable'
    $('api-status').classList.add('bad')
  })
}

boot()
