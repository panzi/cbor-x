# msgpackr

The msgpackr package is an extremely fast MessagePack NodeJS/JavaScript implementation. Currently, it is significantly faster than any other known implementations, faster than Avro (for JS), and generally faster than native V8 JSON.stringify/parse. It also includes an optional record extension (the `r` in msgpackr), for defining record structures that makes MessagePack even faster and more compact, often over twice as fast as even native JSON functions and several times faster than other JS implementations. See the performance section for more details.

## Basic Usage

Install with:

```
npm i msgpackr
```
And `import` or `require` it for basic standard serialization/encoding (`pack`) and deserialization/decoding (`unpack`) functions:
```
import { unpack, pack } from 'msgpackr';
let serializedAsBuffer = pack(value);
let data = unpack(serializedAsBuffer);
```
This `pack` function will generate standard MessagePack without any extensions that should be compatible with any standard MessagePack parser/decoder. It will serialize JavaScript objects as MessagePack `map`s by default. The `unpack` function will deserialize MessagePack `map`s as an `Object` with the properties from the map.

## Node Usage
The msgpackr package runs on any modern JS platform, but is optimized for NodeJS usage (and will use a node addon for performance boost as an optional dependency).

### Streams
We can use the including streaming functionality (which further improves performance). The `PackrStream` is a NodeJS transform stream that can be used to serialize objects to a binary stream (writing to network/socket, IPC, etc.), and the `UnpackrStream` can be used to deserialize objects from a binary sream (reading from network/socket, etc.):

```
import { PackrStream } from 'msgpackr';
let stream = PackrStream();
stream.write(myData);

```
Or for a full example of sending and receiving data on a stream:
```
import { PackrStream } from 'msgpackr';
let sendingStream = PackrStream();
let receivingStream = UnpackrStream();
// we are just piping to our own stream, but normally you would send and
// receive over some type of inter-process or network connection.
sendingStream.pipe(receivingStream);
sendingStream.write(myData);
receivingStream.on('data', (data) => {
	// received data
});
```
 The `PackrStream` and `UnpackrStream` instances  will have also the record structure extension enabled by default (see below).

## Browser Usage
Msgpackr works as standalone JavaScript as well, and runs on modern browsers. It includes a bundled script for ease of direct loading. For module-based development, it is recommended that you directly import the module of interest, to minimize dependencies that get pulled into your application:
```
import { unpack } from 'msgpackr/unpack' // if you only need to unpack
```
(It is worth noting that while msgpackr works well in modern browsers, the MessagePack format itself is usually not an ideal format for web use. If you want compact data, brotli or gzip are most effective in compressing, and MessagePack's character frequency tends to defeat Huffman encoding used by these standard compression algorithms, resulting in less compact data than compressed JSON. The modern browser architecture is heavily optimized for parsing JSON from HTTP traffic, and it is difficult to achieve the same level of overall efficiency and ease with MessagePack.)

### Alternate Terminology
If you prefer to use encoder/decode terminology, msgpackr exports aliases, so `decode` is equivalent to `unpack`, `encode` is `pack`, `Encoder` is `Packr`, `Decoder` is `Unpackr`, and `EncoderStream` and `DecoderStream` can be used as well.

## Record / Object Structures
There is a critical difference between maps (or dictionaries) that hold an arbitrary set of keys and values (JavaScript `Map` is designed for these), and records or object structures that have a well-defined set of fields. Typical JS objects/records may have many instances re(use) the same structure. By using the record extension, this distinction is preserved in MessagePack and the encoding can reuse structures and not only provides better type preservation, but yield much more compact encodings and increase decoding performance by 2-3x. Msgpackr automatically generates record definitions that are reused and referenced by objects with the same structure. There are a number of ways to use this to our advantage. For large object structures with repeating nested objects with similar structures, simply serializing with the record extension can yield significant benefits. To use the record structures extension, we create a new `Packr` instance. By default a new `Packr` instance will have the record extension enabled:
```
import { Packr } from 'msgpackr';
let packr = Packr();
packr.pack(bigDataWithLotsOfObjects);

```

Another way to further leverage the benefits of the msgpackr record structures is to use streams that naturally allow for data to reuse based on previous record structures. The stream classes have the record structure extension enabled by default and provide excellent out-of-the-box performance.

When creating a new `Packr`, `Unpackr`, `PackrStream`, or `UnpackrStream` instance, we can enable or disable the record structure extension with the `useRecords` property. When this is `false`, the record structure extension will be disabled (standard/compatibility mode), and all objects will revert to being serialized using MessageMap `map`s, and all `map`s will be deserialized to JS `Object`s as properties (like the standalone `pack` and `unpack` functions).

### Shared Record Structures
Another useful way of using msgpackr, and the record extension, is for storing data in a databases, files, or other storage systems. If a number of objects with common data structures are being stored, a shared structure can be used to greatly improve data storage and deserialization efficiency. We just need to provide a way to store the generated shared structure so it is available to deserialize stored data in the future:

```
import { Packr } from 'msgpackr';
let packr = Packr({
	getStructures() {
		// storing our data in file (but we could also store in a db or key-value store)
		return unpack(readFileSync('my-shared-structures.mp')) || [];
	},
	saveStructures(structures) {
		writeFileSync('my-shared-structures.mp', pack(structures));
	},
	structures: []
});
```
Msgpackr will automatically add and saves structures as it encounters any new object structures (up to a limit of 32). It will always add structures in an incremental/compatible way: Any object encoded with an earlier structure can be decoded with a later version (as long as it is persisted).

## Options
The following options properties can be provided to the Packr or Unpackr constructor:
* `useRecords` - Setting this to `false` disables the record extension and stores JavaScript objects as MessagePack maps, and unpacks maps as JavaScript `Object`s, which ensures compatibilty with other decoders.
* `structures` - Provides the array of structures that is to be used for record extension, if you want the structures saved and used again.
* `mapsAsObjects` - If `true`, this will decode MessagePack maps and JS `Object`s with the map entries decoded to object properties. If `false`, maps are decoded as JavaScript `Map`s. This is disabled by default if `useRecords` is enabled (which allows `Map`s to be preserved), and is enabled by default if `useRecords` is disabled.
* `variableMapSize` - This will use varying map size definition (fixmap, map16, map32) based on the number of keys when encoding objects, which yields slightly more compact encodings (for small objects), but is typically 5-10% slower during encoding. This is only relevant when record extension is disabled.
* `useTimestamp32` - Encode JS `Date`s in 32-bit format when possible. This causes the milliseconds to be dropped, but is a much more efficient encoding of dates.

## Performance
Msgpackr is fast. Really fast. Here is comparison with the next fastest JS projects using the benchmark tool from `msgpack-lite` (and the sample data is from some clinical research data we use that has a good mix of different value types and structures). It also includes comparison to V8 native JSON functionality, and JavaScript Avro (`avsc`, a very optimized Avro implementation):

operation                                                  |   op   |   ms  |  op/s
---------------------------------------------------------- | ------: | ----: | -----:
buf = Buffer(JSON.stringify(obj));                         |   75900 |  5003 |  15170
obj = JSON.parse(buf);                                     |   90800 |  5002 |  18152
require("msgpackr").pack(obj);                             |  158400 |  5000 |  31680
require("msgpackr").unpack(buf);                           |   99200 |  5003 |  19828
msgpackr w/ shared structures: packr.pack(obj);            |  183400 |  5002 |  36665
msgpackr w/ shared structures: packr.unpack(buf);          |  415000 |  5000 |  83000
buf = require("msgpack-lite").encode(obj);                 |   30600 |  5005 |   6113
obj = require("msgpack-lite").decode(buf);                 |   15900 |  5030 |   3161
buf = require("@msgpack/msgpack").encode(obj);             |  101200 |  5001 |  20235
obj = require("@msgpack/msgpack").decode(buf);             |   71200 |  5004 |  14228
buf = require("msgpack5")().encode(obj);                   |    8100 |  5041 |   1606
obj = require("msgpack5")().decode(buf);                   |   14000 |  5014 |   2792
buf = require("notepack").encode(obj);                     |   65300 |  5006 |  13044
obj = require("notepack").decode(buf);                     |   32300 |  5001 |   6458
require("avsc")...make schema/type...type.toBuffer(obj);   |   86900 |  5002 |  17373
require("avsc")...make schema/type...type.fromBuffer(obj); |  106100 |  5000 |  21220

All benchmarks were performed on Node 14.8.0 (Windows i7-4770 3.4Ghz).
(`avsc` is schema-based and more comparable in style to msgpackr with shared structures).

Here is a benchmark of streaming data (again borrowed from `msgpack-lite`'s benchmarking), where msgpackr is able to take advantage of the structured record extension and really demonstrate its performance capabilities:

operation (1000000 x 2)                          |   op    |  ms   |  op/s
------------------------------------------------ | ------: | ----: | -----:
new PackrStream().write(obj);                    | 1000000 |   372 | 2688172
new UnpackrStream().write(buf);                  | 1000000 |   247 | 4048582
stream.write(msgpack.encode(obj));               | 1000000 |  2898 | 345065
stream.write(msgpack.decode(buf));               | 1000000 |  1969 | 507872
stream.write(notepack.encode(obj));              | 1000000 |   901 | 1109877
stream.write(notepack.decode(buf));              | 1000000 |  1012 | 988142
msgpack.Encoder().on("data",ondata).encode(obj); | 1000000 |  1763 | 567214
msgpack.createDecodeStream().write(buf);         | 1000000 |  2222 | 450045
msgpack.createEncodeStream().write(obj);         | 1000000 |  1577 | 634115
msgpack.Decoder().on("data",ondata).decode(buf); | 1000000 |  2246 | 445235

See the benchmark.md for more benchmarks and information about benchmarking.

## Custom Extensions
You can add your own custom extensions, which can be used to encode specific classes in certain ways. This is done by using the `addExtension` function, and specifying the class, extension type code (a number from 0-127, but 72 is reserved for records), and your pack and unpack functions (or just the one you need). You can use msgpackr encoding and decoding within your extensions, but if you do so, you must create a separate Packr instance, otherwise you could do override data in the same encoding buffer:
```
import { addExtension, Packr } from 'msgpackr';

class MyCustomClass {...}

let extPackr = new Packr();
addExtension({
	Class: MyCustomClass,
	type: 11, // register our own extension code (a type code from 0-127)
	pack(instance) {
		// define how your custom class should be encoded
		return extPackr.pack(instance.myData); // return a buffer
	}
	unpack(buffer) {
		// define how your custom class should be decoded
		let instance = new MyCustomClass();
		instance.myData = extPackr.unpack(buffer);
		return instance; // decoded value from buffer
	}
});
```

### Additional Performance Optimizations
Msgpackr is already fast, but here are some tips for making it faster:

#### Buffer Reuse
Msgpackr is designed to work well with reusable buffers. Allocating new buffers can be relatively expensive, so if you have Node addons, it can be much faster to reuse buffers and use memcpy to copy data into existing buffers. Then msgpackr `unpack` can be executed on the same buffer, with new data, and optionally take a second paramter indicating the effective size of the available data in the buffer.

#### Arena Allocation (`resetMemory()`)
During the serialization process, data is written to buffers. Again, allocating new buffers is a relatively expensive process, and the `resetMemory` method can help allow reuse of buffers that will further improve performance. The `resetMemory` method can be called when previously created buffer(s) are no longer needed. For example, if we serialized an object, and wrote it to a database, we could indicate that we are done:
```
let buffer = packr.pack(data);
writeToStorageSync(buffer);
// finished with buffer, we can reset the memory on our packr now:
packr.resetMemory();
// future serialization can now reuse memory for better performance
```
The use of `resetMemory` is never required, buffers will still be handled and cleaned up through GC if not used, it just provides a small performance boost.

## Record Structure Extension Definition
The record struction extension uses extension id 0x72 ("r") to declare the use of this functionality. The extension "data" byte (or bytes) identifies the byte or bytes used to identify the start of a record in the subsequent MessagePack block or stream. The identifier byte (or the first byte in a sequence) must be from 0x40 - 0x7f (and therefore replaces one byte representations of positive integers 64 - 127, which can alternately be represented with int or uint types). The extension declaration must be immediately follow by an MessagePack array that defines the field names of the record structure.

Once a record identifier and record field names have been defined, the parser/decoder should proceed to read the next value. Any subsequent use of the record identifier as a value in the block or stream should parsed as a record instance, and the next n values, where is n is the number of fields (as defined in the array of field names), should be read as the values of the fields. For example, here we have defined a structure with fields "foo" and "bar", with the record identifier 0x40, and then read a record instance that defines the field values of 4 and 2, respectively:
```
+--------+--------+--------+~~~~~~~~~~~~~~~~~~~~~~~~~+--------+--------+--------+
|  0xd4  |  0x72  |  0x40  | array: [ "foo", "bar" ] |  0x40  |  0x04  |  0x02  |
+--------+--------+--------+~~~~~~~~~~~~~~~~~~~~~~~~~+--------+--------+--------+
```
Which should generate an object that would correspond to JSON:
```
{ "name" : 4, "bar": 2}
```

## Additional value types
msgpackr supports `undefined` (using fixext1 + type: 0 + data: 0 to match other JS implementations), `NaN`, `Infinity`, and `-Infinity` (using standard IEEE 754 representations with doubles/floats).

### Dates
msgpackr saves all JavaScript `Date`s using the standard MessagePack date extension (type -1), using 32-bit if useTimestamp32 options is specified or 64-bit or 96-bit depending on the date.

## License

MIT

### Credits

Various projects have been inspirations for this, and code has been borrowed from https://github.com/msgpack/msgpack-javascript and https://github.com/mtth/avsc.