module BP3D.Items {
  /** Meta data for items. */
  export interface Metadata {
    /** Name of the item. */
    itemName?: string;

    /** Type of the item. */
    itemType?: number;
    
    /** Url of the model. */
    modelUrl?: string;

    /** Optional GLB/GLTF url for AR parity. */
    glbUrl?: string;

    /** Catalogue product id, e.g. "sofa". Renderer-independent identity: mesh
     * urls change when the asset pipeline does, these do not. */
    productId?: string;

    /** Catalogue variant id within the product, e.g. "grey". */
    variantId?: string;

    /** Resizeable or not */
    resizable?: boolean;
  }
}