'use strict'

const v8Util = process.atomBinding('v8_util')

const getOwnerKey = (webContents, processId) => {
  if (!processId) {
    return `${webContents.id}-${webContents.getProcessId()}`
  } else {
    return `${webContents.id}-${processId}`
  }
}

class ObjectsRegistry {
  constructor () {
    this.nextId = 0

    // Stores all objects by ref-counting.
    // (id) => {object, count}
    this.storage = {}

    // Stores the IDs of objects referenced by WebContents.
    // (ownerKey) => {contextId, [id]}
    this.owners = {}

    // Stores context id between process swaps.
    // (contextId) => {oldOwnerKey, newOwnerKey}
    this.contexts = {}
  }

  // Register a new object and return its assigned ID. If the object is already
  // registered then the already assigned ID would be returned.
  add (webContents, contextId, obj) {
    // Get or assign an ID to the object.
    const id = this.saveToStorage(obj)

    // Add object to the set of referenced objects.
    let ownerKey = getOwnerKey(webContents)
    let owner = this.owners[ownerKey]
    if (!owner) {
      owner = this.owners[ownerKey] = {
        contextId: contextId,
        storageSet: new Set()
      }
      this.registerDeleteListener(webContents, ownerKey, contextId)
      this.registerProcessChangeListener(webContents, ownerKey, contextId)
    } else if (owner.contextId !== contextId) {
      // The browser process notifies about process swaps before we receive
      // the contextId from the finalized render process, so there
      // will be a conflict with the contextId. We update the new owner with
      // finalized contextId.
      let context = this.contexts[owner.contextId]
      if (context && context.oldOwnerKey === ownerKey) {
        owner = this.owners[context.newOwnerKey] = {
          contextId: contextId,
          storageSet: new Set()
        }
        ownerKey = context.newOwnerKey
        delete this.contexts[owner.contextId]
      } else {
        // When the renderer was reloaded without a process swap,
        // update the contextId. (ex: sandbox mode)
        this.owners[ownerKey].contextId = contextId
      }
      this.registerDeleteListener(webContents, ownerKey, contextId)
      this.registerProcessChangeListener(webContents, ownerKey, contextId)
    }
    if (!owner.storageSet.has(id)) {
      owner.storageSet.add(id)
      // Increase reference count if not referenced before.
      this.storage[id].count++
    }
    return id
  }

  // Get an object according to its ID.
  get (id) {
    const pointer = this.storage[id]
    if (pointer != null) return pointer.object
  }

  // Dereference an object according to its ID.
  // Note that an object may be double-freed (cleared when page is reloaded, and
  // then garbage collected in old page).
  remove (webContents, contextId, id) {
    const ownerKey = getOwnerKey(webContents)
    let owner = this.owners[ownerKey]
    if (owner && owner.contextId === contextId) {
      // Remove the reference in owner.
      owner.storageSet.delete(id)
      // Dereference from the storage.
      this.dereference(id)
    }
  }

  // Clear all references to objects refrenced by the WebContents.
  clear (ownerKey, contextId) {
    let owner = this.owners[ownerKey]

    if (!owner || owner.contextId !== contextId) return

    for (let id of owner.storageSet) this.dereference(id)

    delete this.owners[ownerKey]
    delete this.contexts[contextId]
  }

  // Private: Saves the object into storage and assigns an ID for it.
  saveToStorage (object) {
    let id = v8Util.getHiddenValue(object, 'atomId')
    if (!id) {
      id = ++this.nextId
      this.storage[id] = {
        count: 0,
        object: object
      }
      v8Util.setHiddenValue(object, 'atomId', id)
    }
    return id
  }

  // Private: Dereference the object from store.
  dereference (id) {
    let pointer = this.storage[id]
    if (pointer == null) {
      return
    }
    pointer.count -= 1
    if (pointer.count === 0) {
      v8Util.deleteHiddenValue(pointer.object, 'atomId')
      delete this.storage[id]
    }
  }

  // Private: Clear the storage when renderer process is destroyed.
  registerDeleteListener (webContents, ownerKey, contextId) {
    let processId = webContents.getProcessId()
    const listener = (event, deletedProcessId) => {
      if (deletedProcessId === processId) {
        webContents.removeListener('render-view-deleted', listener)
        this.clear(ownerKey, contextId)
      }
    }
    webContents.on('render-view-deleted', listener)
  }

  // Private: In PlzNavigate there will be multiple intermediate
  // processes (currently there are 2) before the final render process
  // is swapped in. We try to maintain a map of these swaps and
  // update the reigstry with new owners.
  registerProcessChangeListener (webContents, ownerKey, contextId) {
    let processId = webContents.getProcessId()
    const processChangeListener = (event, oldProcessId, newProcessId) => {
      if (oldProcessId === processId) {
        let owner = this.owners[ownerKey]
        if (owner) {
          let newOwnerKey = getOwnerKey(webContents.id, newProcessId)
          this.contexts[contextId] = {
            oldOwnerKey: ownerKey,
            newOwnerKey: newOwnerKey
          }
          webContents.removeListener('render-frame-changed', processChangeListener)
        }
      }
    }
    webContents.on('render-frame-changed', processChangeListener)
  }
}

module.exports = new ObjectsRegistry()
