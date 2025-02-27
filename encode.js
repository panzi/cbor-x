import { Decoder, mult10, Tag, typedArrays, addExtension as decodeAddExtension } from './decode.js'
let textEncoder
try {
	textEncoder = new TextEncoder()
} catch (error) {}
let extensions, extensionClasses
const hasNodeBuffer = typeof Buffer !== 'undefined'
const ByteArrayAllocate = hasNodeBuffer ? Buffer.allocUnsafeSlow : Uint8Array
const ByteArray = hasNodeBuffer ? Buffer : Uint8Array
const RECORD_INLINE_ID = 0xdfff // temporary first-come first-serve tag // proposed tag: 0x7265 // 're'
const MAX_STRUCTURES = 0x100
const MAX_BUFFER_SIZE = hasNodeBuffer ? 0x100000000 : 0x7fd00000
let serializationId = 1
let target
let targetView
let position = 0
let safeEnd
let bundledStrings = null
const MAX_BUNDLE_SIZE = 0xf000
const hasNonLatin = /[\u0080-\uFFFF]/
const RECORD_SYMBOL = Symbol('record-id')
export class Encoder extends Decoder {
	constructor(options) {
		super(options)
		this.offset = 0
		let typeBuffer
		let start
		let sharedStructures
		let hasSharedUpdate
		let structures
		let referenceMap
		options = options || {}
		let lastSharedStructuresLength = 0
		let encodeUtf8 = ByteArray.prototype.utf8Write ? function(string, position, maxBytes) {
			return target.utf8Write(string, position, maxBytes)
		} : (textEncoder && textEncoder.encodeInto) ?
			function(string, position) {
				return textEncoder.encodeInto(string, target.subarray(position)).written
			} : false

		let encoder = this
		let maxSharedStructures = options.maxSharedStructures || 128
		let isSequential = options.sequential
		if (isSequential) {
			maxSharedStructures = 0
			this.structures = []
		}
		let samplingPackedValues, packedObjectMap, sharedValues = options.sharedValues
		let sharedPackedObjectMap
		if (sharedValues) {
			sharedPackedObjectMap = Object.create(null)
			for (let i = 0, l = sharedValues.length; i < l; i++) {
				sharedPackedObjectMap[sharedValues[i]] = i
			}
		}
		let recordIdsToRemove = []
		let transitionsCount = 0
		let serializationsSinceTransitionRebuild = 0

		this.encode = function(value, encodeOptions) {
			if (!target) {
				target = new ByteArrayAllocate(8192)
				targetView = new DataView(target.buffer, 0, 8192)
				position = 0
			}
			safeEnd = target.length - 10
			if (safeEnd - position < 0x800) {
				// don't start too close to the end, 
				target = new ByteArrayAllocate(target.length)
				targetView = new DataView(target.buffer, 0, target.length)
				safeEnd = target.length - 10
				position = 0
			} else if (encodeOptions === REUSE_BUFFER_MODE)
				position = (position + 7) & 0x7ffffff8 // Word align to make any future copying of this buffer faster
			start = position
			referenceMap = encoder.structuredClone ? new Map() : null
			if (encoder.bundleStrings && typeof value !== 'string') {
				bundledStrings = []
				bundledStrings.size = Infinity // force a new bundle start on first string
			} else
				bundledStrings = null

			sharedStructures = encoder.structures
			if (sharedStructures) {
				if (sharedStructures.uninitialized) {
					let sharedData = encoder.getStructures()
					encoder.structures = sharedStructures = sharedData && sharedData.structures || []
					encoder.sharedValues = sharedPackedObjectMap = sharedData && sharedData.sharedValues
				}
				let sharedStructuresLength = sharedStructures.length
				if (sharedStructuresLength > maxSharedStructures && !isSequential)
					sharedStructuresLength = maxSharedStructures
				if (!sharedStructures.transitions) {
					// rebuild our structure transitions
					sharedStructures.transitions = Object.create(null)
					for (let i = 0; i < sharedStructuresLength; i++) {
						let keys = sharedStructures[i]
						if (!keys)
							continue
						let nextTransition, transition = sharedStructures.transitions
						for (let j = 0, l = keys.length; j < l; j++) {
							let key = keys[j]
							nextTransition = transition[key]
							if (!nextTransition) {
								nextTransition = transition[key] = Object.create(null)
							}
							transition = nextTransition
						}
						transition[RECORD_SYMBOL] = i
					}
					lastSharedStructuresLength = sharedStructures.length
				}
				if (!isSequential)
					sharedStructures.nextId = sharedStructuresLength
			}
			if (hasSharedUpdate)
				hasSharedUpdate = false
			structures = sharedStructures || []
			packedObjectMap = sharedPackedObjectMap
			if (options.pack) {
				let packedValues = new Map()
				packedValues.values = []
				packedValues.encoder = encoder
				packedValues.maxValues = options.maxPrivatePackedValues || (sharedPackedObjectMap ? 16 : Infinity)
				packedValues.objectMap = sharedPackedObjectMap || false
				packedValues.samplingPackedValues = samplingPackedValues
				findRepetitiveStrings(value, packedValues)
				if (packedValues.values.length > 0) {
					target[position++] = 0xd8 // one-byte tag
					target[position++] = 51 // tag 51 for packed shared structures https://www.potaroo.net/ietf/ids/draft-ietf-cbor-packed-03.txt
					writeArrayHeader(4)
					let valuesArray = packedValues.values
					encode(valuesArray)
					writeArrayHeader(0) // prefixes
					writeArrayHeader(0) // suffixes
					packedObjectMap = Object.create(sharedPackedObjectMap || null)
					for (let i = 0, l = valuesArray.length; i < l; i++) {
						packedObjectMap[valuesArray[i]] = i
					}
				}
			}
			try {
				encode(value)
				if (bundledStrings) {
					writeBundles(start, encode)
				}
				encoder.offset = position // update the offset so next serialization doesn't write over our buffer, but can continue writing to same buffer sequentially
				if (referenceMap && referenceMap.idsToInsert) {
					position += referenceMap.idsToInsert.length * 2
					if (position > safeEnd)
						makeRoom(position)
					encoder.offset = position
					let serialized = insertIds(target.subarray(start, position), referenceMap.idsToInsert)
					referenceMap = null
					return serialized
				}
				if (encodeOptions & REUSE_BUFFER_MODE) {
					target.start = start
					target.end = position
					return target
				}
				return target.subarray(start, position) // position can change if we call pack again in saveStructures, so we get the buffer now
			} finally {
				if (sharedStructures) {
					if (serializationsSinceTransitionRebuild < 10)
						serializationsSinceTransitionRebuild++
					if (transitionsCount > 10000) {
						// force a rebuild occasionally after a lot of transitions so it can get cleaned up
						sharedStructures.transitions = null
						serializationsSinceTransitionRebuild = 0
						transitionsCount = 0
						if (recordIdsToRemove.length > 0)
							recordIdsToRemove = []
					} else if (recordIdsToRemove.length > 0 && !isSequential) {
						for (let i = 0, l = recordIdsToRemove.length; i < l; i++) {
							recordIdsToRemove[i][RECORD_SYMBOL] = undefined
						}
						recordIdsToRemove = []
					}
					if (hasSharedUpdate && encoder.saveStructures) {
						if (encoder.structures.length > maxSharedStructures) {
							encoder.structures = encoder.structures.slice(0, maxSharedStructures)
						}
						// we can't rely on start/end with REUSE_BUFFER_MODE since they will (probably) change when we save
						let returnBuffer = target.subarray(start, position)
						let shared = encoder.structures || []
						if (sharedValues) {
							shared = shared.concat(sharedValues)
						}

						if (encoder.saveStructures(new SharedData(encoder.structures, sharedValues, encoder.sharedVersion), encoder.sharedVersion) === false) {
							// get updated structures and try again if the update failed
							let sharedData = encoder.getStructures()
							encoder.structures = sharedStructures = sharedData && sharedData.structures || []
							encoder.sharedValues = sharedPackedObjectMap = sharedData && sharedData.sharedValues
							return encoder.encode(value)
						}
						lastSharedStructuresLength = shared.length
						return returnBuffer
					}
				}
				if (encodeOptions & RESET_BUFFER_MODE)
					position = start
			}
		}
		this.findCommonStringsToPack = () => {
			samplingPackedValues = new Map()
			if (!sharedPackedObjectMap)
				sharedPackedObjectMap = Object.create(null)
			return ({ threshold }) => {
				threshold = threshold || 4
				let position = this.pack ? options.maxPrivatePackedValues || 16 : 0
				if (!sharedValues)
					sharedValues = this.sharedValues = []
				for (let [ key, status ] of samplingPackedValues) {
					if (status.count > threshold) {
						sharedPackedObjectMap[key] = position++
						sharedValues.push(key)
						hasSharedUpdate = true
					}
				}
				samplingPackedValues = null
			}
		}
		const encode = (value) => {
			if (position > safeEnd)
				target = makeRoom(position)

			var type = typeof value
			var length
			if (type === 'string') {
				if (packedObjectMap) {
					let packedPosition = packedObjectMap[value]
					if (packedPosition >= 0) {
						if (packedPosition < 16)
							target[position++] = packedPosition + 0xe0 // simple values, defined in https://www.potaroo.net/ietf/ids/draft-ietf-cbor-packed-03.txt
						else {
							target[position++] = 0xc6 // tag 6 defined in https://www.potaroo.net/ietf/ids/draft-ietf-cbor-packed-03.txt
							if (packedPosition & 1)
								encode((15 - packedPosition) >> 1)
							else
								encode((packedPosition - 16) >> 1)
						}
						return
/*						} else if (packedStatus.serializationId != serializationId) {
							packedStatus.serializationId = serializationId
							packedStatus.count = 1
							if (options.sharedPack) {
								let sharedCount = packedStatus.sharedCount = (packedStatus.sharedCount || 0) + 1
								if (shareCount > (options.sharedPack.threshold || 5)) {
									let sharedPosition = packedStatus.position = packedStatus.nextSharedPosition
									hasSharedUpdate = true
									if (sharedPosition < 16)
										target[position++] = sharedPosition + 0xc0

								}
							}
						} // else any in-doc incrementation?*/
					} else if (samplingPackedValues && !options.pack) {
						let status = samplingPackedValues.get(value)
						if (status)
							status.count++
						else
							samplingPackedValues.set(value, {
								count: 1,
							})
					}
				}
				let strLength = value.length
				if (bundledStrings && strLength >= 4 && strLength < 0x400) {
					if ((bundledStrings.size += strLength) > MAX_BUNDLE_SIZE) {
						let extStart
						let maxBytes = (bundledStrings[0] ? bundledStrings[0].length * 3 + bundledStrings[1].length : 0) + 10
						if (position + maxBytes > safeEnd)
							target = makeRoom(position + maxBytes)
						target[position++] = 0xd9 // tag 16-bit
						target[position++] = 0xdf // tag 0xdff9
						target[position++] = 0xf9
						// TODO: If we only have one bundle with any string data, only write one string bundle
						target[position++] = bundledStrings.position ? 0x84 : 0x82 // array of 4 or 2 elements depending on if we write bundles
						target[position++] = 0x1a // 32-bit unsigned int
						extStart = position - start
						position += 4 // reserve for writing bundle reference
						if (bundledStrings.position) {
							writeBundles(start, encode) // write the last bundles
						}
						bundledStrings = ['', ''] // create new ones
						bundledStrings.size = 0
						bundledStrings.position = extStart
					}
					let twoByte = hasNonLatin.test(value)
					bundledStrings[twoByte ? 0 : 1] += value
					target[position++] = twoByte ? 0xce : 0xcf
					encode(strLength);
					return
				}
				let headerSize
				// first we estimate the header size, so we can write to the correct location
				if (strLength < 0x20) {
					headerSize = 1
				} else if (strLength < 0x100) {
					headerSize = 2
				} else if (strLength < 0x10000) {
					headerSize = 3
				} else {
					headerSize = 5
				}
				let maxBytes = strLength * 3
				if (position + maxBytes > safeEnd)
					target = makeRoom(position + maxBytes)

				if (strLength < 0x40 || !encodeUtf8) {
					let i, c1, c2, strPosition = position + headerSize
					for (i = 0; i < strLength; i++) {
						c1 = value.charCodeAt(i)
						if (c1 < 0x80) {
							target[strPosition++] = c1
						} else if (c1 < 0x800) {
							target[strPosition++] = c1 >> 6 | 0xc0
							target[strPosition++] = c1 & 0x3f | 0x80
						} else if (
							(c1 & 0xfc00) === 0xd800 &&
							((c2 = value.charCodeAt(i + 1)) & 0xfc00) === 0xdc00
						) {
							c1 = 0x10000 + ((c1 & 0x03ff) << 10) + (c2 & 0x03ff)
							i++
							target[strPosition++] = c1 >> 18 | 0xf0
							target[strPosition++] = c1 >> 12 & 0x3f | 0x80
							target[strPosition++] = c1 >> 6 & 0x3f | 0x80
							target[strPosition++] = c1 & 0x3f | 0x80
						} else {
							target[strPosition++] = c1 >> 12 | 0xe0
							target[strPosition++] = c1 >> 6 & 0x3f | 0x80
							target[strPosition++] = c1 & 0x3f | 0x80
						}
					}
					length = strPosition - position - headerSize
				} else {
					length = encodeUtf8(value, position + headerSize, maxBytes)
				}

				if (length < 0x18) {
					target[position++] = 0x60 | length
				} else if (length < 0x100) {
					if (headerSize < 2) {
						target.copyWithin(position + 2, position + 1, position + 1 + length)
					}
					target[position++] = 0x78
					target[position++] = length
				} else if (length < 0x10000) {
					if (headerSize < 3) {
						target.copyWithin(position + 3, position + 2, position + 2 + length)
					}
					target[position++] = 0x79
					target[position++] = length >> 8
					target[position++] = length & 0xff
				} else {
					if (headerSize < 5) {
						target.copyWithin(position + 5, position + 3, position + 3 + length)
					}
					target[position++] = 0x7a
					targetView.setUint32(position, length)
					position += 4
				}
				position += length
			} else if (type === 'number') {
				if (value >>> 0 === value) {// positive integer, 32-bit or less
					// positive uint
					if (value < 0x18) {
						target[position++] = value
					} else if (value < 0x100) {
						target[position++] = 0x18
						target[position++] = value
					} else if (value < 0x10000) {
						target[position++] = 0x19
						target[position++] = value >> 8
						target[position++] = value & 0xff
					} else {
						target[position++] = 0x1a
						targetView.setUint32(position, value)
						position += 4
					}
				} else if (value >> 0 === value) { // negative integer
					if (value >= -0x18) {
						target[position++] = 0x1f - value
					} else if (value >= -0x100) {
						target[position++] = 0x38
						target[position++] = ~value
					} else if (value >= -0x10000) {
						target[position++] = 0x39
						targetView.setUint16(position, ~value)
						position += 2
					} else {
						target[position++] = 0x3a
						targetView.setUint32(position, ~value)
						position += 4
					}
				} else {
					let useFloat32
					if ((useFloat32 = this.useFloat32) > 0 && value < 0x100000000 && value >= -0x80000000) {
						target[position++] = 0xfa
						targetView.setFloat32(position, value)
						let xShifted
						if (useFloat32 < 4 ||
								// this checks for rounding of numbers that were encoded in 32-bit float to nearest significant decimal digit that could be preserved
								((xShifted = value * mult10[((target[position] & 0x7f) << 1) | (target[position + 1] >> 7)]) >> 0) === xShifted) {
							position += 4
							return
						} else
							position-- // move back into position for writing a double
					}
					target[position++] = 0xfb
					targetView.setFloat64(position, value)
					position += 8
				}
			} else if (type === 'object') {
				if (!value)
					target[position++] = 0xf6
				else {
					if (referenceMap) {
						let referee = referenceMap.get(value)
						if (referee) {
							target[position++] = 0xd8
							target[position++] = 29 // http://cbor.schmorp.de/value-sharing
							target[position++] = 0x19 // 16-bit uint
							if (!referee.references) {
								let idsToInsert = referenceMap.idsToInsert || (referenceMap.idsToInsert = [])
								referee.references = []
								idsToInsert.push(referee)
							}
							referee.references.push(position - start)
							position += 2 // TODO: also support 32-bit
							return
						} else 
							referenceMap.set(value, { offset: position - start })
					}
					let constructor = value.constructor
					if (constructor === Object) {
						writeObject(value, true)
					} else if (constructor === Array) {
						length = value.length
						if (length < 0x18) {
							target[position++] = 0x80 | length
						} else {
							writeArrayHeader(length)
						}
						for (let i = 0; i < length; i++) {
							encode(value[i])
						}
					} else if (constructor === Map) {
						if (this.mapsAsObjects ? this.useTag259ForMaps !== false : this.useTag259ForMaps) {
							// use Tag 259 (https://github.com/shanewholloway/js-cbor-codec/blob/master/docs/CBOR-259-spec--explicit-maps.md) for maps if the user wants it that way
							target[position++] = 0xd9
							target[position++] = 1
							target[position++] = 3
						}
						length = value.size
						if (length < 0x18) {
							target[position++] = 0xa0 | length
						} else if (length < 0x100) {
							target[position++] = 0xb8
							target[position++] = length
						} else if (length < 0x10000) {
							target[position++] = 0xb9
							target[position++] = length >> 8
							target[position++] = length & 0xff
						} else {
							target[position++] = 0xba
							targetView.setUint32(position, length)
							position += 4
						}
						for (let [ key, entryValue ] of value) {
							encode(key)
							encode(entryValue)
						}
					} else {	
						for (let i = 0, l = extensions.length; i < l; i++) {
							let extensionClass = extensionClasses[i]
							if (value instanceof extensionClass) {
								let extension = extensions[i]
								let tag = extension.tag || extension.getTag && extension.getTag(value)
								if (tag < 0x18) {
									target[position++] = 0xc0 | tag
								} else if (tag < 0x100) {
									target[position++] = 0xd8
									target[position++] = tag
								} else if (tag < 0x10000) {
									target[position++] = 0xd9
									target[position++] = tag >> 8
									target[position++] = tag & 0xff
								} else if (tag > -1) {
									target[position++] = 0xda
									targetView.setUint32(position, tag)
									position += 4
								} // else undefined, don't write tag
								extension.encode.call(this, value, encode, makeRoom)
								return
							}
						}
						if (value[Symbol.iterator]) {
							target[position++] = 0x9f // indefinite length array
							for (let entry of value) {
								encode(entry)
							}
							target[position++] = 0xff // stop-code
							return
						}
						// no extension found, write as object
						writeObject(value, !value.hasOwnProperty) // if it doesn't have hasOwnProperty, don't do hasOwnProperty checks
					}
				}
			} else if (type === 'boolean') {
				target[position++] = value ? 0xf5 : 0xf4
			} else if (type === 'bigint') {
				if (value < (BigInt(1)<<BigInt(64)) && value >= 0) {
					// use an unsigned int as long as it fits
					target[position++] = 0x1b
					targetView.setBigUint64(position, value)
				} else if (value > -(BigInt(1)<<BigInt(64)) && value < 0) {
					// if we can fit an unsigned int, use that
					target[position++] = 0x3b
					targetView.setBigUint64(position, -value - BigInt(1))
				} else {
					// overflow
					if (this.largeBigIntToFloat) {
						target[position++] = 0xfb
						targetView.setFloat64(position, Number(value))
					} else {
						throw new RangeError(value + ' was too large to fit in CBOR 64-bit integer format, set largeBigIntToFloat to convert to float-64')
					}
				}
				position += 8
			} else if (type === 'undefined') {
				target[position++] = 0xf7
			} else {
				throw new Error('Unknown type: ' + type)
			}
		}

		const writeObject = this.useRecords === false ? this.variableMapSize ? (object) => {
			// this method is slightly slower, but generates "preferred serialization" (optimally small for smaller objects)
			let keys = Object.keys(object)
			let length = keys.length
			if (length < 0x18) {
				target[position++] = 0xa0 | length
			} else if (length < 0x100) {
				target[position++] = 0xb8
				target[position++] = length
			} else if (length < 0x10000) {
				target[position++] = 0xb9
				target[position++] = length >> 8
				target[position++] = length & 0xff
			} else {
				target[position++] = 0xba
				targetView.setUint32(position, length)
				position += 4
			}
			let key
			for (let i = 0; i < length; i++) {
				encode(key = keys[i])
				encode(object[key])
			}
		} :
		(object, safePrototype) => {
			target[position++] = 0xb9 // always use map 16, so we can preallocate and set the length afterwards
			let objectOffset = position - start
			position += 2
			let size = 0
			for (let key in object) {
				if (safePrototype || object.hasOwnProperty(key)) {
					encode(key)
					encode(object[key])
					size++
				}
			}
			target[objectOffset++ + start] = size >> 8
			target[objectOffset + start] = size & 0xff
		} :

	/*	sharedStructures ?  // For highly stable structures, using for-in can a little bit faster
		(object, safePrototype) => {
			let nextTransition, transition = structures.transitions || (structures.transitions = Object.create(null))
			let objectOffset = position++ - start
			let wroteKeys
			for (let key in object) {
				if (safePrototype || object.hasOwnProperty(key)) {
					nextTransition = transition[key]
					if (!nextTransition) {
						nextTransition = transition[key] = Object.create(null)
						nextTransition.__keys__ = (transition.__keys__ || []).concat([key])
						/*let keys = Object.keys(object)
						if 
						let size = 0
						let startBranch = transition.__keys__ ? transition.__keys__.length : 0
						for (let i = 0, l = keys.length; i++) {
							let key = keys[i]
							size += key.length << 2
							if (i >= startBranch) {
								nextTransition = nextTransition[key] = Object.create(null)
								nextTransition.__keys__ = keys.slice(0, i + 1)
							}
						}
						makeRoom(position + size)
						nextTransition = transition[key]
						target.copy(target, )
						objectOffset
					}
					transition = nextTransition
					encode(object[key])
				}
			}
			let id = transition.id
			if (!id) {
				id = transition.id = structures.push(transition.__keys__) + 63
				if (sharedStructures.onUpdate)
					sharedStructures.onUpdate(id, transition.__keys__)
			}
			target[objectOffset + start] = id
		}*/
		(object) => {
			let keys = Object.keys(object)
			let nextTransition, transition = structures.transitions || (structures.transitions = Object.create(null))
			let newTransitions = 0
			let length = keys.length
			//let parentRecordId
			for (let i = 0; i < length; i++) {
				let key = keys[i]
				//if (!parentRecordId)
				//	parentRecordId = transition[RECORD_SYMBOL]
				nextTransition = transition[key]
				if (!nextTransition) {
					nextTransition = transition[key] = Object.create(null)
					newTransitions++
				}
				transition = nextTransition
			}
			let recordId = transition[RECORD_SYMBOL]
			if (recordId !== undefined) {
				target[position++] = 0xd9
				target[position++] = (recordId >> 8) | 0xe0
				target[position++] = recordId & 0xff
			} else {
				recordId = structures.nextId++
				if (!recordId) {
					recordId = 0
					structures.nextId = 1
				}
				if (recordId >= MAX_STRUCTURES) {// cycle back around
					structures.nextId = (recordId = maxSharedStructures) + 1
				}
				transition[RECORD_SYMBOL] = recordId
				structures[recordId] = keys
				if (sharedStructures && sharedStructures.length <= maxSharedStructures) {
					target[position++] = 0xd9
					target[position++] = (recordId >> 8) | 0xe0
					target[position++] = recordId & 0xff
					hasSharedUpdate = true
				} else {
					targetView.setUint32(position, 0xd9dfff00) // tag two byte, then record definition id
					position += 3
					if (newTransitions)
						transitionsCount += serializationsSinceTransitionRebuild * newTransitions
					// record the removal of the id, we can maintain our shared structure
					if (recordIdsToRemove.length >= MAX_STRUCTURES - maxSharedStructures)
						recordIdsToRemove.shift()[RECORD_SYMBOL] = undefined // we are cycling back through, and have to remove old ones
					recordIdsToRemove.push(transition)
					writeArrayHeader(length + 2)
					encode(0xe000 + recordId)
					encode(keys)
					// now write the values
					for (let i =0; i < length; i++)
						encode(object[keys[i]])
					return
				}
			}
			if (length < 0x18) { // write the array header
				target[position++] = 0x80 | length
			} else {
				writeArrayHeader(length)
			}
			for (let i =0; i < length; i++)
				encode(object[keys[i]])
		}
		const makeRoom = (end) => {
			let newSize
			if (end > 0x1000000) {
				// special handling for really large buffers
				if ((end - start) > MAX_BUFFER_SIZE)
					throw new Error('Encoded buffer would be larger than maximum buffer size')
				newSize = Math.min(MAX_BUFFER_SIZE,
					Math.round(Math.max((end - start) * (end > 0x4000000 ? 1.25 : 2), 0x400000) / 0x1000) * 0x1000)
			} else // faster handling for smaller buffers
				newSize = ((Math.max((end - start) << 2, target.length - 1) >> 12) + 1) << 12
			let newBuffer = new ByteArrayAllocate(newSize)
			targetView = new DataView(newBuffer.buffer, 0, newSize)
			if (target.copy)
				target.copy(newBuffer, 0, start, end)
			else
				newBuffer.set(target.slice(start, end))
			position -= start
			start = 0
			safeEnd = newBuffer.length - 10
			return target = newBuffer
		}
	}
	useBuffer(buffer) {
		// this means we are finished using our own buffer and we can write over it safely
		target = buffer
		targetView = new DataView(target.buffer, target.byteOffset, target.byteLength)
		position = 0
	}
}
class SharedData {
	constructor(structures, values, version) {
		this.structures = structures
		this.values = values
		this.version = version
	}
}

function writeArrayHeader(length) {
	if (length < 0x18)
		target[position++] = 0x80 | length
	else if (length < 0x100) {
		target[position++] = 0x98
		target[position++] = length
	} else if (length < 0x10000) {
		target[position++] = 0x99
		target[position++] = length >> 8
		target[position++] = length & 0xff
	} else {
		target[position++] = 0x9a
		targetView.setUint32(position, length)
		position += 4
	}
}

function findRepetitiveStrings(value, packedValues) {
	switch(typeof value) {
		case 'string':
			if (value.length > 3) {
				if (packedValues.objectMap[value] > -1 || packedValues.values.length >= packedValues.maxValues)
					return
				let packedStatus = packedValues.get(value)
				if (packedStatus) {
					if (++packedStatus.count == 2) {
						packedValues.values.push(value)
					}
				} else {
					packedValues.set(value, {
						count: 1,
					})
					if (packedValues.samplingPackedValues) {
						let status = packedValues.samplingPackedValues.get(value)
						if (status)
							status.count++
						else
							packedValues.samplingPackedValues.set(value, {
								count: 1,
							})
					}
				}
			}
			break
		case 'object':
			if (value) {
				if (value instanceof Array) {
					for (let i = 0, l = value.length; i < l; i++) {
						findRepetitiveStrings(value[i], packedValues)
					}

				} else {
					let includeKeys = !packedValues.encoder.useRecords
					for (var key in value) {
						if (value.hasOwnProperty(key)) {
							if (includeKeys)
								findRepetitiveStrings(key, packedValues)
							findRepetitiveStrings(value[key], packedValues)
						}
					}
				}
			}
			break
		case 'function': console.log(value)
	}
}

extensionClasses = [ Date, Set, Error, RegExp, Tag, ArrayBuffer, ByteArray,
	Uint8Array, Uint8ClampedArray, Uint16Array, Uint32Array,
	typeof BigUint64Array == 'undefined' ? function() {} : BigUint64Array, Int8Array, Int16Array, Int32Array,
	typeof BigInt64Array == 'undefined' ? function() {} : BigInt64Array,
	Float32Array, Float64Array, SharedData]

//Object.getPrototypeOf(Uint8Array.prototype).constructor /*TypedArray*/
extensions = [{
	tag: 1,
	encode(date, encode) {
		let seconds = date.getTime() / 1000
		if ((this.useTimestamp32 || date.getMilliseconds() === 0) && seconds >= 0 && seconds < 0x100000000) {
			// Timestamp 32
			target[position++] = 0x1a
			targetView.setUint32(position, seconds)
			position += 4
		} else {
			// Timestamp float64
			target[position++] = 0xfb
			targetView.setFloat64(position, seconds)
			position += 8
		}
	}
}, {
	tag: 258, // https://github.com/input-output-hk/cbor-sets-spec/blob/master/CBOR_SETS.md
	encode(set, encode) {
		let array = Array.from(set)
		encode(array)
	}
}, {
	tag: 27, // http://cbor.schmorp.de/generic-object
	encode(error, encode) {
		encode([ error.name, error.message ])
	}
}, {
	tag: 27, // http://cbor.schmorp.de/generic-object
	encode(regex, encode) {
		encode([ 'RegExp', regex.source, regex.flags ])
	}
}, {
	getTag(tag) {
		return tag.tag
	},
	encode(tag, encode) {
		encode(tag.value)
	}
}, {
	encode(arrayBuffer, encode, makeRoom) {
		writeBuffer(arrayBuffer, makeRoom)
	}
}, {
	encode(arrayBuffer, encode, makeRoom) {
		writeBuffer(arrayBuffer, makeRoom)
	}
}, typedArrayEncoder(64),
	typedArrayEncoder(68),
	typedArrayEncoder(69),
	typedArrayEncoder(70),
	typedArrayEncoder(71),
	typedArrayEncoder(72),
	typedArrayEncoder(77),
	typedArrayEncoder(78),
	typedArrayEncoder(79),
	typedArrayEncoder(81),
	typedArrayEncoder(82),
{
	encode(sharedData, encode) { // write SharedData
		let packedValues = sharedData.values || []
		let sharedStructures = sharedData.structures || []
		if (packedValues.values.length > 0) {
			target[position++] = 0xd8 // one-byte tag
			target[position++] = 51 // tag 51 for packed shared structures https://www.potaroo.net/ietf/ids/draft-ietf-cbor-packed-03.txt
			writeArrayHeader(4)
			let valuesArray = packedValues.values
			encode(valuesArray)
			writeArrayHeader(0) // prefixes
			writeArrayHeader(0) // suffixes
			packedObjectMap = Object.create(sharedPackedObjectMap || null)
			for (let i = 0, l = valuesArray.length; i < l; i++) {
				packedObjectMap[valuesArray[i]] = i
			}
		}
		if (sharedStructures) {
			targetView.setUint32(position, 0xd9dffe00)
			position += 3
			let definitions = sharedStructures.slice(0)
			definitions.unshift(0xe000)
			definitions.push(new Tag(++sharedStructures.version, 0x53687264))
			encode(definitions)
		} else
			encode(new Tag(++sharedData.version, 0xdffd))
		}
	}]

function typedArrayEncoder(tag) {
	return {
		tag: tag,
		encode: function writeExtBuffer(typedArray, encode) {
			let length = typedArray.byteLength
			let offset = typedArray.byteOffset || 0
			let buffer = typedArray.buffer || typedArray
			encode(hasNodeBuffer ? Buffer.from(buffer, offset, length) :
				new Uint8Array(buffer, offset, length))
		}
	}
}
function writeBuffer(buffer, makeRoom) {
	let length = buffer.byteLength
	if (length < 0x18) {
		target[position++] = 0x40 + length
	} else if (length < 0x100) {
		target[position++] = 0x58
		target[position++] = length
	} else if (length < 0x10000) {
		target[position++] = 0x59
		target[position++] = length >> 8
		target[position++] = length & 0xff
	} else {
		target[position++] = 0x5a
		targetView.setUint32(position, length)
		position += 4
	}
	if (position + length >= target.length) {
		makeRoom(position + length)
	}
	target.set(buffer, position)
	position += length
}

function insertIds(serialized, idsToInsert) {
	// insert the ids that need to be referenced for structured clones
	let nextId
	let distanceToMove = idsToInsert.length * 2
	let lastEnd = serialized.length - distanceToMove
	idsToInsert.sort((a, b) => a.offset > b.offset ? 1 : -1)
	for (let id = 0; id < idsToInsert.length; id++) {
		let referee = idsToInsert[id]
		referee.id = id
		for (let position of referee.references) {
			serialized[position++] = id >> 8
			serialized[position] = id & 0xff
		}
	}
	while (nextId = idsToInsert.pop()) {
		let offset = nextId.offset
		serialized.copyWithin(offset + distanceToMove, offset, lastEnd)
		distanceToMove -= 2
		let position = offset + distanceToMove
		serialized[position++] = 0xd8
		serialized[position++] = 28 // http://cbor.schmorp.de/value-sharing
		lastEnd = offset
	}
	return serialized
}
function writeBundles(start, encode) {
	targetView.setUint32(bundledStrings.position + start, position - bundledStrings.position - start + 1) // the offset to bundle
	let writeStrings = bundledStrings
	bundledStrings = null
	encode(writeStrings[0])
	encode(writeStrings[1])
}

export function addExtension(extension) {
	if (extension.Class) {
		if (!extension.encode)
			throw new Error('Extension has no encode function')
		extensionClasses.unshift(extension.Class)
		extensions.unshift(extension)
	}
	decodeAddExtension(extension)
}
let defaultEncoder = new Encoder({ useRecords: false })
export const encode = defaultEncoder.encode
export { FLOAT32_OPTIONS } from './decode.js'
import { FLOAT32_OPTIONS } from './decode.js'
export const { NEVER, ALWAYS, DECIMAL_ROUND, DECIMAL_FIT } = FLOAT32_OPTIONS
export const REUSE_BUFFER_MODE = 512
export const RESET_BUFFER_MODE = 1024

