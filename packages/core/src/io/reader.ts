import { determinant, getRotation } from 'gl-matrix/mat4'
import { length } from 'gl-matrix/vec3'
import { GLB_BUFFER, PropertyType, TypedArray, mat4, vec3, vec4 } from '../constants';
import { Document } from '../document';
import { Extension } from '../extension';
import { JSONDocument } from '../json-document';
import { Accessor } from '../properties';
import { GLTF } from '../types/gltf';
import { FileUtils, ImageUtils, Logger } from '../utils';
import { ReaderContext } from './reader-context';

const ComponentTypeToTypedArray = {
	'5120': Int8Array,
	'5121': Uint8Array,
	'5122': Int16Array,
	'5123': Uint16Array,
	'5125': Uint32Array,
	'5126': Float32Array,
};

export interface ReaderOptions {
	logger?: Logger;
	extensions: (typeof Extension)[];
	dependencies: {[key: string]: unknown};
}

const DEFAULT_OPTIONS: ReaderOptions = {
	logger: Logger.DEFAULT_INSTANCE,
	extensions: [],
	dependencies: {},
};

/** @hidden */
export class GLTFReader {
	public static read(jsonDoc: JSONDocument, options: ReaderOptions = DEFAULT_OPTIONS): Document {
		const {json} = jsonDoc;
		const doc = new Document();

		this.validate(jsonDoc, options);

		/* Reader context. */

		const context = new ReaderContext(jsonDoc);

		/** Asset. */

		const assetDef = jsonDoc.json.asset;
		const asset = doc.getRoot().getAsset();

		if (assetDef.copyright) asset.copyright = assetDef.copyright;
		if (assetDef.extras) asset.extras = assetDef.extras;
		if (assetDef.generator) asset.generator = assetDef.generator;
		if (assetDef.minVersion) asset.minVersion = assetDef.minVersion;

		/** Extensions (1/2). */

		const extensionsUsed = json.extensionsUsed || [];
		const extensionsRequired = json.extensionsRequired || [];
		for (const Extension of options.extensions) {
			if (extensionsUsed.includes(Extension.EXTENSION_NAME)) {
				const extension = doc.createExtension(Extension as unknown as new (doc: Document) => Extension)
					.setRequired(extensionsRequired.includes(Extension.EXTENSION_NAME));

				for (const key of extension.dependencies) {
					extension.install(key, options.dependencies[key]);
				}
			}
		}

		/** Buffers. */

		const bufferDefs = json.buffers || [];
		context.buffers = bufferDefs.map((bufferDef) => {
			const buffer = doc.createBuffer(bufferDef.name);

			if (bufferDef.extras) buffer.setExtras(bufferDef.extras);

			if (bufferDef.uri && bufferDef.uri.indexOf('__') !== 0) {
				buffer.setURI(bufferDef.uri);
			}

			return buffer;
		});

		/** Buffer views. */

		const bufferViewDefs = json.bufferViews || [];
		context.bufferViewBuffers = bufferViewDefs.map((bufferViewDef) => {
			return context.buffers[bufferViewDef.buffer];
		});

		/** Accessors. */

		// Accessor .count and .componentType properties are inferred dynamically.
		const accessorDefs = json.accessors || [];
		context.accessors = accessorDefs.map((accessorDef) => {
			const buffer = context.bufferViewBuffers[accessorDef.bufferView];
			const accessor = doc.createAccessor(accessorDef.name, buffer).setType(accessorDef.type);

			if (accessorDef.extras) accessor.setExtras(accessorDef.extras);

			if (accessorDef.normalized !== undefined) {
				accessor.setNormalized(accessorDef.normalized);
			}

			// KHR_draco_mesh_compression.
			if (accessorDef.bufferView === undefined && !accessorDef.sparse) return accessor;

			let array: TypedArray;

			if (accessorDef.sparse !== undefined) {
				array = getSparseArray(accessorDef, jsonDoc);
			} else {
				// TODO(cleanup): Relying to much on ArrayBuffers: requires copying.
				array = getAccessorArray(accessorDef, jsonDoc).slice();
			}

			accessor.setArray(array);
			return accessor;
		});

		/** Textures. */

		// glTF-Transform's "Texture" properties correspond 1:1 with glTF "Image" properties, and
		// with image files. The glTF file may contain more one texture per image, where images
		// are reused with different sampler properties.
		const imageDefs = json.images || [];
		const textureDefs = json.textures || [];
		doc.getRoot().listExtensionsUsed()
			.filter((extension) => extension.provideTypes.includes(PropertyType.TEXTURE))
			.forEach((extension) => extension.provide(context, PropertyType.TEXTURE));
		context.textures = imageDefs.map((imageDef) => {
			const texture = doc.createTexture(imageDef.name);

			// glTF Image corresponds 1:1 with glTF-Transform Texture. See `writer.ts`.
			if (imageDef.extras) texture.setExtras(imageDef.extras);

			if (imageDef.bufferView !== undefined) {
				const bufferViewDef = json.bufferViews[imageDef.bufferView];
				const bufferDef = jsonDoc.json.buffers[bufferViewDef.buffer];
				const bufferData = bufferDef.uri
					? jsonDoc.resources[bufferDef.uri]
					: jsonDoc.resources[GLB_BUFFER];
				const byteOffset = bufferViewDef.byteOffset || 0;
				const byteLength = bufferViewDef.byteLength;
				const imageData = bufferData.slice(byteOffset, byteOffset + byteLength);
				texture.setImage(imageData);
			} else if (imageDef.uri !== undefined) {
				texture.setImage(jsonDoc.resources[imageDef.uri]);
				if (imageDef.uri.indexOf('__') !== 0) {
					texture.setURI(imageDef.uri);
				}
			}

			if (imageDef.mimeType !== undefined) {
				texture.setMimeType(imageDef.mimeType);
			} else if (imageDef.uri) {
				const extension = FileUtils.extension(imageDef.uri);
				texture.setMimeType(ImageUtils.extensionToMimeType(extension));
			}

			return texture;
		});

		/** Materials. */

		const materialDefs = json.materials || [];
		context.materials = materialDefs.map((materialDef) => {
			const material = doc.createMaterial(materialDef.name);

			if (materialDef.extras) material.setExtras(materialDef.extras);

			// Program state & blending.

			if (materialDef.alphaMode !== undefined) {
				material.setAlphaMode(materialDef.alphaMode);
			}

			if (materialDef.alphaCutoff !== undefined) {
				material.setAlphaCutoff(materialDef.alphaCutoff);
			}

			if (materialDef.doubleSided !== undefined) {
				material.setDoubleSided(materialDef.doubleSided);
			}

			// Factors.

			const pbrDef = materialDef.pbrMetallicRoughness || {};

			if (pbrDef.baseColorFactor !== undefined) {
				material.setBaseColorFactor(pbrDef.baseColorFactor as vec4);
			}

			if (materialDef.emissiveFactor !== undefined) {
				material.setEmissiveFactor(materialDef.emissiveFactor as vec3);
			}

			if (pbrDef.metallicFactor !== undefined) {
				material.setMetallicFactor(pbrDef.metallicFactor);
			}

			if (pbrDef.roughnessFactor !== undefined) {
				material.setRoughnessFactor(pbrDef.roughnessFactor);
			}

			// Textures.

			if (pbrDef.baseColorTexture !== undefined) {
				const textureInfoDef = pbrDef.baseColorTexture;
				const texture = context.textures[textureDefs[textureInfoDef.index].source];
				material.setBaseColorTexture(texture);
				context.setTextureInfo(material.getBaseColorTextureInfo(), textureInfoDef);
			}

			if (materialDef.emissiveTexture !== undefined) {
				const textureInfoDef = materialDef.emissiveTexture;
				const texture = context.textures[textureDefs[textureInfoDef.index].source];
				material.setEmissiveTexture(texture);
				context.setTextureInfo(material.getEmissiveTextureInfo(), textureInfoDef);
			}

			if (materialDef.normalTexture !== undefined) {
				const textureInfoDef = materialDef.normalTexture;
				const texture = context.textures[textureDefs[textureInfoDef.index].source];
				material.setNormalTexture(texture);
				context.setTextureInfo(material.getNormalTextureInfo(), textureInfoDef);
				if (materialDef.normalTexture.scale !== undefined) {
					material.setNormalScale(materialDef.normalTexture.scale);
				}
			}

			if (materialDef.occlusionTexture !== undefined) {
				const textureInfoDef = materialDef.occlusionTexture;
				const texture = context.textures[textureDefs[textureInfoDef.index].source];
				material.setOcclusionTexture(texture);
				context.setTextureInfo(material.getOcclusionTextureInfo(), textureInfoDef);
				if (materialDef.occlusionTexture.strength !== undefined) {
					material.setOcclusionStrength(materialDef.occlusionTexture.strength);
				}
			}

			if (pbrDef.metallicRoughnessTexture !== undefined) {
				const textureInfoDef = pbrDef.metallicRoughnessTexture;
				const texture = context.textures[textureDefs[textureInfoDef.index].source];
				material.setMetallicRoughnessTexture(texture);
				context.setTextureInfo(material.getMetallicRoughnessTextureInfo(), textureInfoDef);
			}

			return material;
		});

		/** Meshes. */

		const meshDefs = json.meshes || [];
		doc.getRoot().listExtensionsUsed()
			.filter((extension) => extension.provideTypes.includes(PropertyType.PRIMITIVE))
			.forEach((extension) => extension.provide(context, PropertyType.PRIMITIVE));
		context.meshes = meshDefs.map((meshDef) => {
			const mesh = doc.createMesh(meshDef.name);

			if (meshDef.extras) mesh.setExtras(meshDef.extras);

			if (meshDef.weights !== undefined) {
				mesh.setWeights(meshDef.weights);
			}

			meshDef.primitives.forEach((primitiveDef) => {
				const primitive = doc.createPrimitive();

				if (primitiveDef.extras) primitive.setExtras(primitiveDef.extras);

				if (primitiveDef.material !== undefined) {
					primitive.setMaterial(context.materials[primitiveDef.material]);
				}

				if (primitiveDef.mode !== undefined) {
					primitive.setMode(primitiveDef.mode);
				}

				for (const [semantic, index] of Object.entries(primitiveDef.attributes || {})) {
					primitive.setAttribute(semantic, context.accessors[index]);
				}

				if (primitiveDef.indices !== undefined) {
					primitive.setIndices(context.accessors[primitiveDef.indices]);
				}

				const targetNames = meshDef.extras && meshDef.extras.targetNames || [];
				const targetDefs = primitiveDef.targets || [];
				targetDefs.forEach((targetDef, targetIndex) => {
					const targetName = targetNames[targetIndex] || targetIndex.toString();
					const target = doc.createPrimitiveTarget(targetName);

					for (const [semantic, accessorIndex] of Object.entries(targetDef)) {
						target.setAttribute(semantic, context.accessors[accessorIndex]);
					}

					primitive.addTarget(target);
				});

				mesh.addPrimitive(primitive);
			})

			return mesh;
		});

		/** Cameras. */

		const cameraDefs = json.cameras || [];
		context.cameras = cameraDefs.map((cameraDef) => {
			const camera = doc.createCamera(cameraDef.name).setType(cameraDef.type);

			if (cameraDef.extras) camera.setExtras(cameraDef.extras);

			if (cameraDef.type === GLTF.CameraType.PERSPECTIVE) {
				camera
					.setZNear(cameraDef.perspective.znear)
					.setZFar(cameraDef.perspective.zfar)
					.setYFov(cameraDef.perspective.yfov)
					.setAspectRatio(cameraDef.perspective.aspectRatio);
			} else {
				camera
					.setZNear(cameraDef.orthographic.znear)
					.setZFar(cameraDef.orthographic.zfar)
					.setXMag(cameraDef.orthographic.xmag)
					.setYMag(cameraDef.orthographic.ymag);
			}
			return camera;
		});

		/** Nodes. */

		const nodeDefs = json.nodes || [];
		context.nodes = nodeDefs.map((nodeDef) => {
			const node = doc.createNode(nodeDef.name);

			if (nodeDef.extras) node.setExtras(nodeDef.extras);

			if (nodeDef.translation !== undefined) {
				node.setTranslation(nodeDef.translation as vec3);
			}

			if (nodeDef.rotation !== undefined) {
				node.setRotation(nodeDef.rotation as vec4);
			}

			if (nodeDef.scale !== undefined) {
				node.setScale(nodeDef.scale as vec3);
			}

			if (nodeDef.matrix !== undefined) {
				const translation = [0, 0, 0] as vec3;
				const rotation = [0, 0, 0, 1] as vec4;
				const scale = [1, 1, 1] as vec3;

				decompose(nodeDef.matrix as mat4, rotation, translation, scale);

				node.setTranslation(translation);
				node.setRotation(rotation);
				node.setScale(scale);
			}

			if (nodeDef.weights !== undefined) {
				node.setWeights(nodeDef.weights);
			}

			// Attachments (mesh, camera, skin) defined later in reading process.

			return node;
		});

		/** Skins. */

		const skinDefs = json.skins || [];
		context.skins = skinDefs.map((skinDef) => {
			const skin = doc.createSkin(skinDef.name);

			if (skinDef.extras) skin.setExtras(skinDef.extras);

			if (skinDef.inverseBindMatrices !== undefined) {
				skin.setInverseBindMatrices(context.accessors[skinDef.inverseBindMatrices]);
			}

			if (skinDef.skeleton !== undefined) {
				skin.setSkeleton(context.nodes[skinDef.skeleton]);
			}

			for (const nodeIndex of skinDef.joints) {
				skin.addJoint(context.nodes[nodeIndex]);
			}

			return skin;
		});

		/** Node attachments. */

		nodeDefs.map((nodeDef, nodeIndex) => {
			const node = context.nodes[nodeIndex];

			const children = nodeDef.children || [];
			children.forEach((childIndex) => node.addChild(context.nodes[childIndex]));

			if (nodeDef.mesh !== undefined) node.setMesh(context.meshes[nodeDef.mesh]);

			if (nodeDef.camera !== undefined) node.setCamera(context.cameras[nodeDef.camera]);

			if (nodeDef.skin !== undefined) node.setSkin(context.skins[nodeDef.skin]);
		})

		/** Animations. */

		const animationDefs = json.animations || [];
		context.animations = animationDefs.map((animationDef) => {
			const animation = doc.createAnimation(animationDef.name);

			if (animationDef.extras) animation.setExtras(animationDef.extras);

			const samplerDefs = animationDef.samplers || [];
			const samplers = samplerDefs.map((samplerDef) => {
				const sampler = doc.createAnimationSampler()
					.setInput(context.accessors[samplerDef.input])
					.setOutput(context.accessors[samplerDef.output])
					.setInterpolation(samplerDef.interpolation || GLTF.AnimationSamplerInterpolation.LINEAR);

				if (samplerDef.extras) sampler.setExtras(samplerDef.extras);

				animation.addSampler(sampler);
				return sampler;
			})

			const channels = animationDef.channels || [];
			channels.forEach((channelDef) => {
				const channel = doc.createAnimationChannel()
					.setSampler(samplers[channelDef.sampler])
					.setTargetNode(context.nodes[channelDef.target.node])
					.setTargetPath(channelDef.target.path);

				if (channelDef.extras) channel.setExtras(channelDef.extras);

				animation.addChannel(channel);
			});

			return animation;
		});

		/** Scenes. */

		const sceneDefs = json.scenes || [];
		context.scenes = sceneDefs.map((sceneDef) => {
			const scene = doc.createScene(sceneDef.name);

			if (sceneDef.extras) scene.setExtras(sceneDef.extras);

			const children = sceneDef.nodes || [];

			children
			.map((nodeIndex) => context.nodes[nodeIndex])
			.forEach((node) => (scene.addChild(node)));

			return scene;
		});

		/** Extensions (2/2). */

		doc.getRoot()
			.listExtensionsUsed()
			.forEach((extension) => extension.read(context));

		return doc;
	}

	private static validate(jsonDoc: JSONDocument, options: ReaderOptions): void {

		const json = jsonDoc.json;

		if (json.asset.version !== '2.0') {
			throw new Error(`Unsupported glTF version, "${json.asset.version}".`);
		}

		if (json.extensionsRequired) {
			for (const extensionName of json.extensionsRequired) {
				if (!options.extensions.find(
						(extension) => extension.EXTENSION_NAME === extensionName)) {
					throw new Error(`Missing required extension, "${extensionName}".`);
				}
			}
		}

		if (json.extensionsUsed) {
			for (const extensionName of json.extensionsUsed) {
				if (!options.extensions.find(
						(extension) => extension.EXTENSION_NAME === extensionName)) {
					options.logger.warn(`Missing optional extension, "${extensionName}".`);
				}
			}
		}

	}
}

/**
 * Returns the contents of an interleaved accessor, as a typed array.
 * @hidden
 */
function getInterleavedArray(accessorDef: GLTF.IAccessor, jsonDoc: JSONDocument): TypedArray {
	const bufferViewDef = jsonDoc.json.bufferViews[accessorDef.bufferView];
	const bufferDef = jsonDoc.json.buffers[bufferViewDef.buffer];
	const resource = bufferDef.uri ? jsonDoc.resources[bufferDef.uri] : jsonDoc.resources[GLB_BUFFER];

	const TypedArray = ComponentTypeToTypedArray[accessorDef.componentType];
	const elementSize = Accessor.getElementSize(accessorDef.type);
	const componentSize = TypedArray.BYTES_PER_ELEMENT;
	const accessorByteOffset = accessorDef.byteOffset || 0;

	const array = new TypedArray(accessorDef.count * elementSize);
	const view = new DataView(resource, bufferViewDef.byteOffset, bufferViewDef.byteLength);
	const byteStride = bufferViewDef.byteStride;

	for (let i = 0; i < accessorDef.count; i++) {
		for (let j = 0; j < elementSize; j++) {
			const byteOffset = accessorByteOffset + i * byteStride + j * componentSize;
			let value: number;
			switch (accessorDef.componentType) {
				case GLTF.AccessorComponentType.FLOAT:
					value = view.getFloat32(byteOffset, true);
					break;
				case GLTF.AccessorComponentType.UNSIGNED_INT:
					value = view.getUint32(byteOffset, true);
					break;
				case GLTF.AccessorComponentType.UNSIGNED_SHORT:
					value = view.getUint16(byteOffset, true);
					break;
				case GLTF.AccessorComponentType.UNSIGNED_BYTE:
					value = view.getUint8(byteOffset);
					break;
				case GLTF.AccessorComponentType.SHORT:
					value = view.getInt16(byteOffset, true);
					break;
				case GLTF.AccessorComponentType.BYTE:
					value = view.getInt8(byteOffset);
					break;
				default:
				throw new Error(`Unexpected componentType "${accessorDef.componentType}".`);
			}
			array[i * elementSize + j] = value;
		}
	}

	return array;
}

/**
 * Returns the contents of an accessor, as a typed array.
 * @hidden
 */
function getAccessorArray(accessorDef: GLTF.IAccessor, jsonDoc: JSONDocument): TypedArray {
	const bufferViewDef = jsonDoc.json.bufferViews[accessorDef.bufferView];
	const bufferDef = jsonDoc.json.buffers[bufferViewDef.buffer];
	const resource = bufferDef.uri ? jsonDoc.resources[bufferDef.uri] : jsonDoc.resources[GLB_BUFFER];

	const TypedArray = ComponentTypeToTypedArray[accessorDef.componentType];
	const elementSize = Accessor.getElementSize(accessorDef.type);
	const componentSize = TypedArray.BYTES_PER_ELEMENT;
	const elementStride = elementSize * componentSize;

	// Interleaved buffer view.
	if (bufferViewDef.byteStride !== undefined && bufferViewDef.byteStride !==  elementStride) {
		return getInterleavedArray(accessorDef, jsonDoc);
	}

	const start = (bufferViewDef.byteOffset || 0) + (accessorDef.byteOffset || 0);

	switch (accessorDef.componentType) {
		case GLTF.AccessorComponentType.FLOAT:
			return new Float32Array(resource, start, accessorDef.count * elementSize);
		case GLTF.AccessorComponentType.UNSIGNED_INT:
			return new Uint32Array(resource, start, accessorDef.count * elementSize);
		case GLTF.AccessorComponentType.UNSIGNED_SHORT:
			return new Uint16Array(resource, start, accessorDef.count * elementSize);
		case GLTF.AccessorComponentType.UNSIGNED_BYTE:
			return new Uint8Array(resource, start, accessorDef.count * elementSize);
		case GLTF.AccessorComponentType.SHORT:
			return new Int16Array(resource, start, accessorDef.count * elementSize);
		case GLTF.AccessorComponentType.BYTE:
			return new Int8Array(resource, start, accessorDef.count * elementSize);
		default:
			throw new Error(`Unexpected componentType "${accessorDef.componentType}".`);
	}
}

/**
 * Returns the contents of a sparse accessor, as a typed array.
 * @hidden
 */
function getSparseArray(accessorDef: GLTF.IAccessor, jsonDoc: JSONDocument): TypedArray {
	const TypedArray = ComponentTypeToTypedArray[accessorDef.componentType];
	const elementSize = Accessor.getElementSize(accessorDef.type);

	let array: TypedArray;
	if (accessorDef.bufferView !== undefined) {
		// TODO(cleanup): Relying to much on ArrayBuffers: requires copying.
		array = getAccessorArray(accessorDef, jsonDoc).slice();
	} else {
		array = new TypedArray(accessorDef.count * elementSize);
	}

	const count = accessorDef.sparse.count;
	const indicesDef = {...accessorDef, ...accessorDef.sparse.indices, count, type: 'SCALAR'};
	const valuesDef = {...accessorDef, ...accessorDef.sparse.values, count};
	const indices = getAccessorArray(indicesDef as GLTF.IAccessor, jsonDoc);
	const values = getAccessorArray(valuesDef, jsonDoc);

	// Override indices given in the sparse data.
	for (let i = 0; i < indicesDef.count; i++) {
		for (let j = 0; j < elementSize; j++) {
			array[indices[i] * elementSize + j] = values[i * elementSize + j];
		}
	}

	return array;
}

// See: https://github.com/toji/gl-matrix/issues/408
function decompose(srcMat: mat4, targetRot: vec4, targetPos: vec3, targetScale: vec3): void {

	let sx = length([srcMat[0], srcMat[1], srcMat[2]]);
	const sy = length([srcMat[4], srcMat[5], srcMat[6]]);
	const sz = length([srcMat[8], srcMat[9], srcMat[10]]);

	// if determine is negative, we need to invert one scale
	const det = determinant(srcMat);
	if (det < 0) sx = - sx;

	targetPos[0] = srcMat[12];
	targetPos[1] = srcMat[13];
	targetPos[2] = srcMat[14];

	// scale the rotation part
	const _m1 = srcMat.slice();

	const invSX = 1 / sx;
	const invSY = 1 / sy;
	const invSZ = 1 / sz;

	_m1[0] *= invSX;
	_m1[1] *= invSX;
	_m1[2] *= invSX;

	_m1[4] *= invSY;
	_m1[5] *= invSY;
	_m1[6] *= invSY;

	_m1[8] *= invSZ;
	_m1[9] *= invSZ;
	_m1[10] *= invSZ;

	getRotation(targetRot, _m1);

	targetScale[0] = sx;
	targetScale[1] = sy;
	targetScale[2] = sz;

}
