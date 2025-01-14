const puppeteer = require('puppeteer-extra')
const StealthPlugin = require('puppeteer-extra-plugin-stealth')
const AdblockerPlugin = require('puppeteer-extra-plugin-adblocker')
const atob = require('atob')
const Queue = require('queue')
const merge = require('deepmerge')

const Order = Symbol('Order')

module.exports = class {
  constructor (options) {
    this.options = {
      session: null,
      selfListen: false,
      workerLimit: 3,
      debug: false,
      ...(options || {})
    }
    this._browser = null // Puppeteer instance
    this._masterPage = null // Holds the master page
    this._workerPages = [] // Holds the worker pages

    this._listenFns = null // Begin as null, changes to [] when primed

    this._aliasMap = {} // Maps user handles to IDs

    this.uid = null // Holds the user's ID when authenticated

    // Handle new messages sequentially
    this._messageQueueIncoming = Queue({
      autostart: true,
      concurrency: 1,
      timeout: 1000
    })

    // Worker thread queue
    this._actionQueueOutgoing = {
      [Order]: []
    }
  }

  threadHandleToID (handle) {
    // FIXME: Should this be ID to Handle???
    // Received messages contain the ID
    // Outgoing messages get changed to the handle
    // But if a user changes their username, the cache will be wrong
    return this._aliasMap[handle] || handle
  }

  async _delegate (thread, fn) {
    console.debug('Received function ', fn, thread)
    if (!thread) throw new Error('No thread target')
    thread = thread.toString()

    let _resolve
    const promise = new Promise(resolve => {
      _resolve = resolve
    })

    const pushQueue = (workerObj, fn) => {
      console.debug('Pushing function to worker thread', workerObj.id)

      workerObj.queue.push(async finish => {
        console.debug('Executing function (finally)')
        workerObj.active = true
        workerObj.lastActivity = new Date()
        _resolve(await fn.apply(workerObj.page))
        finish()
      })
    }

    const replaceWorker = async (workerObj, newThread, hookFn) => {
      console.debug('Replacing worker thread queue', workerObj.id)
      workerObj.thread = null
      workerObj.queue.autostart = false

      hookFn && (await hookFn())

      await this._setTarget(workerObj.page, newThread)
      workerObj.thread = newThread
      workerObj.queue.start()
      workerObj.queue.autostart = true
    }

    const target = this._workerPages.find(
      workerObj => this.threadHandleToID(thread) === workerObj.thread
    )

    if (target) {
      console.debug('Existing worker thread found, pushing')
      // Push new action to target worker queue
      pushQueue(target, fn)
    } else {
      console.debug('Target worker thread not found')
      // Queue new action if there are no free workers
      if (this._workerPages.length >= this.options.workerLimit) {
        const freeTarget = this._workerPages
          .filter(workerObj => !workerObj.active)
          .sort((a, b) => a.lastActivity > b.lastActivity)
          .shift()
        if (freeTarget) {
          replaceWorker(freeTarget, thread, async () =>
            pushQueue(freeTarget, fn)
          )
        } else {
          console.debug('Reached worker thread capacity')
          if (thread in this._actionQueueOutgoing) {
            console.debug('Adding function to existing queue')
            this._actionQueueOutgoing[thread].push(fn)
          } else {
            console.debug('Creating new function queue')
            this._actionQueueOutgoing[thread] = [fn]
            this._actionQueueOutgoing[Order].push(thread)
          }
        }
      } else {
        console.debug('Spawning new worker')
        // Create a new worker if there is an empty worker slot
        const target = {
          thread,
          active: true,
          lastActivity: new Date(),
          queue: Queue({
            autostart: false, // Do not start queue until the new page is ready
            concurrency: 1,
            timeout: 2000
          }),
          id: this._workerPages.length
        }
        pushQueue(target, fn)
        this._workerPages.push(target)

        // Attach page
        const page = await this._browser.newPage()
        await this._setTarget(page, thread)
        target.page = page

        // Handle worker replacement
        target.queue.on('end', async () => {
          console.debug('Worker finished tasks')
          target.active = false
          const next = this._actionQueueOutgoing[Order].shift()
          if (!next) return

          await replaceWorker(target, next, async () => {
            const outgoingQueue = this._actionQueueOutgoing[next]
            delete this._actionQueueOutgoing[next]
            outgoingQueue.forEach(fn => pushQueue(target, fn))
          })
        })

        // Enable queue
        target.queue.start()
        target.queue.autostart = true
      }
    }

    return promise
  }

  async getSession () {
    return this._masterPage.cookies()
  }

  async login (email, password, pOptions) {
    return new Promise(async (resolve, reject) => {
      this.options.debug && console.log('Logging in...')

      puppeteer.use(StealthPlugin())
      puppeteer.use(AdblockerPlugin({ blockTrackers: true }))

      const dOptions = { headless: !this.options.debug, args: [] }
      pOptions = merge(dOptions, pOptions || {})

      const browser = (this._browser = await puppeteer.launch(pOptions))
      const page = (this._masterPage = (await browser.pages())[0]) // await browser.newPage())

      if (this.options.session) {
        await page.setCookie(...this.options.session)
      }

      // await page.setUserAgent("Mozilla/5.0 (Android 7.0; Mobile; rv:54.0) Gecko/54.0 Firefox/54.0")

      // Go to the login page
      await page.goto('https://m.facebook.com/login.php', {
        waitUntil: 'networkidle2'
      })

      // If there's a session (from cookie), then skip login
      let authFail = false
      if (page.url().startsWith('https://m.facebook.com/login.php')) {
        await (async (cb, ...items) =>
          Promise.all(items.map(q => page.$(q))).then(r => cb(...r)))(
          async (emailField, passwordField, submitButton) => {
            // Looks like we're unauthenticated
            await emailField.type(email)
            await passwordField.type(password)
            let navigationPromise = page.waitForNavigation()
            page.$eval('button[name=login]', elem => elem.click())

            setTimeout(async () => {
              if (
                page.url().startsWith('https://m.facebook.com/login.php') &&
                (await Promise.all(
                  [
                    '//div[contains(text(), "find account")]',
                    '//div[contains(text(), "Need help with finding your account?")]',
                    '//div[contains(text(), "The password that you entered is incorrect")]',
                    '//div[contains(text(), "Incorrect password")]'
                  ].map(xPath => page.$x(xPath))
                ).then(r => r.flat().length > 0))
              ) {
                authFail = true
                await this.close()
                reject(new Error('Bad credentials'))
              }
            }, 3000)

            await navigationPromise.catch(() => {})
          },
          'input[name=email]',
          'input[name=pass]',
          'button[name=login]'
        )
      }

      if (!authFail) {
        await page.goto('https://m.facebook.com/messages', {
          waitUntil: 'networkidle2'
        })

        this.uid = (await this.getSession()).find(
          cookie => cookie.name === 'c_user'
        ).value

        this.options.debug && console.log(`Logged in as ${this.uid}`)
        resolve(this)
      }
    })
  }

  getCurrentUserID () {
    /* String */
    return this.uid
  }

  async _setTarget (page, target) {
    target = target.toString()

    const threadPrefix = 'https://mobile.facebook.com/messages/read/?tid='
    let slug = page.url().substr(threadPrefix.length)

    if (target === this.threadHandleToID(slug)) {
      return null
    }

    const response = await page.goto(`${threadPrefix}${target}`, {
      waitUntil: 'networkidle2'
    })

    slug = page.url().substr(threadPrefix.length)
    this._aliasMap[slug] = target

    return response
  }

  async _checkTemporaryBlocked (_delegate, target) {
    let title = await _delegate.title()

    if (title !== 'You’re Temporarily Blocked') return null

    console.debug('Temporarily Blocked')

    const button = await _delegate.$x('//a[contains(text(), "Okay")]')
    await button[0].click()

    return await _delegate.goto(`https://mobile.facebook.com/messages/read/?tid=${target.toString()}`, {
      waitUntil: 'networkidle2'
    })
  }

  async readMessage (target) {
    const parent = this;

    this._delegate(target, async function () {
      await parent._checkTemporaryBlocked(this, target)

      await this.$eval('#page', (el) => el.scrollIntoView())
    })
  }

  async sendMessage (target, data) {
    if (typeof data === 'number') {
      data = data.toString()
    } else if (typeof data === 'function') {
      data = await data()
    }

    const parent = this;

    this._delegate(target, async function () {
      await parent._checkTemporaryBlocked(this, target)

      const inputElem = await this.$('[placeholder="Write a message..."]')

      await inputElem.type(data)
      await this.$eval('button[name=send]', elem => elem.click())
    })
  }

  _stopListen (optionalCallback) {
    const client = this._masterPage._client

    if (typeof optionalCallback === 'function') {
      client.off('Network.webSocketFrameReceived', optionalCallback)
      this._listenFns = this._listenFns.filter(
        callback => callback !== optionalCallback
      )
    } else {
      for (const callback of this._listenFns) {
        client.off('Network.webSocketFrameReceived', callback)
      }
      this._listenFns = []
    }
  }

  listen (callback) {
    return this.listenRaw(async json => {
      const data = {
        body: json.body || '',
        thread: Object.values(json.messageMetadata.threadKey)[0],
        sender: json.messageMetadata.actorFbId,
        timestamp: json.messageMetadata.timestamp,
        messageId: json.messageMetadata.messageId,
        attachments: json.attachments
      }

      await callback(data)
    })
  }

  listenRaw (callback) {
    if (this._listenFns === null) {
      this._listenFns = []

      this._masterPage._client.on(
        'Network.webSocketFrameReceived',
        async ({ timestamp, response: { payloadData } }) => {
          if (payloadData.length > 16) {
            try {
              // :shrug:
              // console.log(atob(payloadData), "\n\n\n")
              const json = JSON.parse(atob(payloadData.substr(16)))

              for (const delta of json.deltas) {
                if (delta.class !== 'NewMessage') continue
                if (
                  delta.messageMetadata.actorFbId === this.uid &&
                  !this.options.selfListen
                ) {
                  continue
                }

                for (const callback of this._listenFns) {
                  this._messageQueueIncoming.push(async finish => {
                    await callback(delta)
                    finish()
                  })
                }
              }
            } catch (e) {
              // * screams in void *
              //   console.debug(atob(payloadData.substr(16)))
            }
          }
        }
      )
    }

    if (this._listenFns.indexOf(callback) === -1) {
      this._listenFns.push(callback)
    }

    return () => this._stopListen(callback)
  }

  async sendImage (target, imagePathOrImagePaths) {
    if (!imagePathOrImagePaths) return

    const images = Array.isArray(imagePathOrImagePaths)
      ? imagePathOrImagePaths
      : Array(imagePathOrImagePaths)

    const parent = this;

    return this._delegate(target, async function () {
      await parent._checkTemporaryBlocked(this, target)

      for (const imagePath of images) {
        let uploadBtn = await this.$(
          'input[type=file][data-sigil="m-raw-file-input"]'
        )
        await uploadBtn.uploadFile(imagePath)
      }

      await this.waitForSelector('button[name=send]:not([disabled])')
      await this.$eval('button[name=send]', elem => elem.click())
    })
  }

  async close () {
    return this._browser.close()
  }
}
