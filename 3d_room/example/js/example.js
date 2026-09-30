
/*
 * Camera Buttons
 */

var CameraButtons = function(blueprint3d) {

  var orbitControls = blueprint3d.three.controls;
  var three = blueprint3d.three;

  var panSpeed = 30;
  var directions = {
    UP: 1,
    DOWN: 2,
    LEFT: 3,
    RIGHT: 4
  }

  function init() {
    // Camera controls
    $("#zoom-in").click(zoomIn);
    $("#zoom-out").click(zoomOut);  
    $("#zoom-in").dblclick(preventDefault);
    $("#zoom-out").dblclick(preventDefault);

    $("#reset-view").click(three.centerCamera)

    $("#move-left").click(function(){
      pan(directions.LEFT)
    })
    $("#move-right").click(function(){
      pan(directions.RIGHT)
    })
    $("#move-up").click(function(){
      pan(directions.UP)
    })
    $("#move-down").click(function(){
      pan(directions.DOWN)
    })

    $("#move-left").dblclick(preventDefault);
    $("#move-right").dblclick(preventDefault);
    $("#move-up").dblclick(preventDefault);
    $("#move-down").dblclick(preventDefault);
  }

  function preventDefault(e) {
    e.preventDefault();
    e.stopPropagation();
  }

  function pan(direction) {
    switch (direction) {
      case directions.UP:
        orbitControls.panXY(0, panSpeed);
        break;
      case directions.DOWN:
        orbitControls.panXY(0, -panSpeed);
        break;
      case directions.LEFT:
        orbitControls.panXY(panSpeed, 0);
        break;
      case directions.RIGHT:
        orbitControls.panXY(-panSpeed, 0);
        break;
    }
  }

  function zoomIn(e) {
    e.preventDefault();
    orbitControls.dollyIn(1.1);
    orbitControls.update();
  }

  function zoomOut(e) {
    e.preventDefault;
    orbitControls.dollyOut(1.1);
    orbitControls.update();
  }

  init();
}

/*
 * 3-axis Transform Gizmo (move/rotate/scale)
 */

var TransformGizmo = function(blueprint3d) {
  if (typeof THREE === 'undefined' || typeof THREE.TransformControls === 'undefined') {
    console.warn('TransformControls not loaded');
    return;
  }

  var three = blueprint3d.three;
  var camera = three.getCamera ? three.getCamera() : null;
  var domElement = (three.controls && three.controls.domElement) || document;
  var scene = blueprint3d.model.scene.getScene();

  if (!camera) {
    console.warn('No camera found for TransformControls');
    return;
  }

  var gizmo = new THREE.TransformControls(camera, domElement);
  gizmo.setMode('translate');
  gizmo.setSpace('world');
  gizmo.visible = false;
  scene.add(gizmo);

  stylizeHandles();

  function setMode(mode) {
    gizmo.setMode(mode);
    ['translate','rotate','scale'].forEach(function(m){
      var btn = $('#gizmo-' + m);
      if (btn.length) {
        if (m === mode) btn.addClass('btn-primary'); else btn.removeClass('btn-primary');
      }
    });
    three.needsUpdate();
  }

  function attach(item) {
    gizmo.attach(item);
    gizmo.visible = true;
    three.needsUpdate();
  }

  function detach() {
    gizmo.detach();
    gizmo.visible = false;
    three.needsUpdate();
  }

  gizmo.addEventListener('change', function(){
    snapToFloor(gizmo.object);
    three.needsUpdate();
    blueprint3d.model.scene.needsUpdate = true;
  });
  gizmo.addEventListener('mouseDown', function(){ three.controls.enabled = false; });
  gizmo.addEventListener('mouseUp', function(){ three.controls.enabled = true; });

  three.itemSelectedCallbacks.add(function(item){ attach(item); });
  three.itemUnselectedCallbacks.add(function(){ detach(); });

  $('#gizmo-translate').click(function(e){ e.preventDefault(); setMode('translate'); });
  $('#gizmo-rotate').click(function(e){ e.preventDefault(); setMode('rotate'); });
  $('#gizmo-scale').click(function(e){ e.preventDefault(); setMode('scale'); });

  window.addEventListener('keydown', function(e){
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    if (e.key === 't' || e.key === 'T') setMode('translate');
    if (e.key === 'r' || e.key === 'R') setMode('rotate');
    if (e.key === 's' || e.key === 'S') setMode('scale');
  });

  // initialize button state
  setMode('translate');

  function snapToFloor(obj) {
    if (!obj || !obj.metadata) return;
    // Floor-bound item types: 1 (floor), 8 (on-floor). Others are left untouched (walls, ceiling, decor).
    var t = obj.metadata.itemType;
    if (t !== 1 && t !== 8) return;

    var box = new THREE.Box3().setFromObject(obj);
    if (!isFinite(box.min.y)) return;
    var offset = -box.min.y; // bring lowest point to y=0
    obj.position.y += offset;
  }

  function stylizeHandles() {
    var pastel = { X: 0xe86a6a, Y: 0x5ac48c, Z: 0x6aa8e8 };
    gizmo.setSize(0.85);

    function applyToGroup(group) {
      Object.keys(group).forEach(function (key) {
        var axis = key.charAt(0);
        var color = pastel[axis] || 0xffffff;
        var handle = group[key];
        if (!handle || !handle.children) return;

        handle.children.forEach(function (child) {
          if (child.material) {
            child.material.color.setHex(color);
            child.material.opacity = 0.9;
            child.material.transparent = true;
            if (child.material.emissive) {
              child.material.emissive.setHex(color);
              child.material.emissiveIntensity = 0.2;
            }
          }
          child.scale.multiplyScalar(0.85);
        });
      });
    }

    ['translate', 'rotate', 'scale'].forEach(function (mode) {
      if (gizmo.gizmo && gizmo.gizmo[mode]) {
        applyToGroup(gizmo.gizmo[mode]);
      }
    });
  }
}

/*
 * Context menu for selected item
 */ 

var ContextMenu = function(blueprint3d) {

  var scope = this;
  var selectedItem;
  var three = blueprint3d.three;

  function init() {
    $("#context-menu-delete").click(function(event) {
        selectedItem.remove();
    });

    three.itemSelectedCallbacks.add(itemSelected);
    three.itemUnselectedCallbacks.add(itemUnselected);

    initResize();

    $("#fixed").click(function() {
        var checked = $(this).prop('checked');
        selectedItem.setFixed(checked);
    });
  }

  function cmToIn(cm) {
    return cm / 2.54;
  }

  function inToCm(inches) {
    return inches * 2.54;
  }

  function itemSelected(item) {
    selectedItem = item;

    $("#context-menu-name").text(item.metadata.itemName);

    $("#item-width").val(cmToIn(selectedItem.getWidth()).toFixed(0));
    $("#item-height").val(cmToIn(selectedItem.getHeight()).toFixed(0));
    $("#item-depth").val(cmToIn(selectedItem.getDepth()).toFixed(0));

    $("#context-menu").show();

    $("#fixed").prop('checked', item.fixed);
  }

  function resize() {
    selectedItem.resize(
      inToCm($("#item-height").val()),
      inToCm($("#item-width").val()),
      inToCm($("#item-depth").val())
    );
  }

  function initResize() {
    $("#item-height").change(resize);
    $("#item-width").change(resize);
    $("#item-depth").change(resize);
  }

  function itemUnselected() {
    selectedItem = null;
    $("#context-menu").hide();
  }

  init();
}

/*
 * Loading modal for items
 */

var ModalEffects = function(blueprint3d) {

  var scope = this;
  var blueprint3d = blueprint3d;
  var itemsLoading = 0;

  this.setActiveItem = function(active) {
    itemSelected = active;
    update();
  }

  function update() {
    if (itemsLoading > 0) {
      $("#loading-modal").show();
    } else {
      $("#loading-modal").hide();
    }
  }

  function init() {
    blueprint3d.model.scene.itemLoadingCallbacks.add(function() {
      itemsLoading += 1;
      update();
    });

     blueprint3d.model.scene.itemLoadedCallbacks.add(function() {
      itemsLoading -= 1;
      update();
    });   

    update();
  }

  init();
}

/*
 * Side menu
 */

var SideMenu = function(blueprint3d, floorplanControls, modalEffects) {
  var blueprint3d = blueprint3d;
  var floorplanControls = floorplanControls;
  var modalEffects = modalEffects;

  var ACTIVE_CLASS = "active";

  var tabs = {
    "FLOORPLAN" : $("#floorplan_tab"),
    "SHOP" : $("#items_tab"),
    "DESIGN" : $("#design_tab")
  }

  var scope = this;
  this.stateChangeCallbacks = $.Callbacks();

  this.states = {
    "DEFAULT" : {
      "div" : $("#viewer"),
      "tab" : tabs.DESIGN
    },
    "FLOORPLAN" : {
      "div" : $("#floorplanner"),
      "tab" : tabs.FLOORPLAN
    },
    "SHOP" : {
      "div" : $("#add-items"),
      "tab" : tabs.SHOP
    }
  }

  // sidebar state
  var currentState = scope.states.FLOORPLAN;

  function init() {
    for (var tab in tabs) {
      var elem = tabs[tab];
      elem.click(tabClicked(elem));
    }

    $("#update-floorplan").click(floorplanUpdate);

    initLeftMenu();
    loadCatalogueIds();

    blueprint3d.three.updateWindowSize();
    handleWindowResize();

    initItems();

    setCurrentState(scope.states.DEFAULT);
  }

  function floorplanUpdate() {
    setCurrentState(scope.states.DEFAULT);
  }

  function tabClicked(tab) {
    return function() {
      // Stop three from spinning
      blueprint3d.three.stopSpin();

      // Selected a new tab
      for (var key in scope.states) {
        var state = scope.states[key];
        if (state.tab == tab) {
          setCurrentState(state);
          break;
        }
      }
    }
  }
  
  function setCurrentState(newState) {

    if (currentState == newState) {
      return;
    }

    // show the right tab as active
    if (currentState.tab !== newState.tab) {
      if (currentState.tab != null) {
        currentState.tab.removeClass(ACTIVE_CLASS);          
      }
      if (newState.tab != null) {
        newState.tab.addClass(ACTIVE_CLASS);
      }
    }

    // set item unselected
    blueprint3d.three.getController().setSelectedObject(null);

    // show and hide the right divs
    currentState.div.hide()
    newState.div.show()

    // custom actions
    if (newState == scope.states.FLOORPLAN) {
      floorplanControls.updateFloorplanView();
      floorplanControls.handleWindowResize();
    } 

    if (currentState == scope.states.FLOORPLAN) {
      blueprint3d.model.floorplan.update();
    }

    if (newState == scope.states.DEFAULT) {
      blueprint3d.three.updateWindowSize();
    }
 
    // set new state
    handleWindowResize();    
    currentState = newState;

    scope.stateChangeCallbacks.fire(newState);
  }

  function initLeftMenu() {
    $( window ).resize( handleWindowResize );
    handleWindowResize();
  }

  function handleWindowResize() {
    $(".sidebar").height(window.innerHeight);
    $("#add-items").height(window.innerHeight);

  };

  // Catalogue identity (product id + variant id) keyed by mesh url. Designs save
  // these so a saved room survives an asset-pipeline change — mesh urls do not:
  // the r69 .js meshes go away when the renderer loads .glb directly.
  // ponytail: read the catalogue rather than duplicating ids into items.js — the
  // panel gets rendered from the catalogue later and this goes away.
  var catalogueIds = {};

  function loadCatalogueIds() {
    function index(data) {
      (data.products || []).forEach(function(product) {
        (product.variants || []).forEach(function(variant) {
          if (variant.model) {
            catalogueIds[variant.model] = {
              productId: product.id,
              variantId: variant.id
            };
          }
        });
      });
    }
    // /api/catalogue is the authority (it adds prices, and validates the file).
    // The static file stays as the fallback for when the Python service is not
    // up — ids are a published contract, so losing them is worse than stale
    // prices we do not read here anyway. On both failing, items save without
    // catalogue identity, exactly as before.
    $.getJSON("/api/catalogue", index).fail(function() {
      $.getJSON("catalogue.json", index);
    });
  }

  // TODO: this doesn't really belong here
  function initItems() {
    $("#add-items").find(".add-item").mousedown(function(e) {
      var modelUrl = $(this).attr("model-url");
      var itemType = parseInt($(this).attr("model-type"));
      var ids = catalogueIds[modelUrl] || {};
      var metadata = {
        itemName: $(this).attr("model-name"),
        resizable: true,
        modelUrl: modelUrl,
        itemType: itemType,
        productId: ids.productId,
        variantId: ids.variantId
      }

      blueprint3d.model.scene.addItem(itemType, modelUrl, metadata);
      setCurrentState(scope.states.DEFAULT);
    });
  }

  init();

}

/*
 * Change floor and wall textures
 */

var TextureSelector = function (blueprint3d, sideMenu) {

  var scope = this;
  var three = blueprint3d.three;
  var isAdmin = isAdmin;

  var currentTarget = null;

  function initTextureSelectors() {
    $(".texture-select-thumbnail").click(function(e) {
      var textureUrl = $(this).attr("texture-url");
      var textureStretch = ($(this).attr("texture-stretch") == "true");
      var textureScale = parseInt($(this).attr("texture-scale"));
      currentTarget.setTexture(textureUrl, textureStretch, textureScale);

      e.preventDefault();
    });
  }

  function init() {
    three.wallClicked.add(wallClicked);
    three.floorClicked.add(floorClicked);
    three.itemSelectedCallbacks.add(reset);
    three.nothingClicked.add(reset);
    sideMenu.stateChangeCallbacks.add(reset);
    initTextureSelectors();
  }

  function wallClicked(halfEdge) {
    currentTarget = halfEdge;
    $("#floorTexturesDiv").hide();  
    $("#wallTextures").show();  
  }

  function floorClicked(room) {
    currentTarget = room;
    $("#wallTextures").hide();  
    $("#floorTexturesDiv").show();  
  }

  function reset() {
    $("#wallTextures").hide();  
    $("#floorTexturesDiv").hide();  
  }

  init();
}

/*
 * Floorplanner controls
 */

var ViewerFloorplanner = function(blueprint3d) {

  var canvasWrapper = '#floorplanner';

  // buttons
  var move = '#move';
  var remove = '#delete';
  var draw = '#draw';

  var activeStlye = 'btn-primary disabled';

  this.floorplanner = blueprint3d.floorplanner;

  var scope = this;

  function init() {

    $( window ).resize( scope.handleWindowResize );
    scope.handleWindowResize();

    // mode buttons
    scope.floorplanner.modeResetCallbacks.add(function(mode) {
      $(draw).removeClass(activeStlye);
      $(remove).removeClass(activeStlye);
      $(move).removeClass(activeStlye);
      if (mode == BP3D.Floorplanner.floorplannerModes.MOVE) {
          $(move).addClass(activeStlye);
      } else if (mode == BP3D.Floorplanner.floorplannerModes.DRAW) {
          $(draw).addClass(activeStlye);
      } else if (mode == BP3D.Floorplanner.floorplannerModes.DELETE) {
          $(remove).addClass(activeStlye);
      }

      if (mode == BP3D.Floorplanner.floorplannerModes.DRAW) {
        $("#draw-walls-hint").show();
        scope.handleWindowResize();
      } else {
        $("#draw-walls-hint").hide();
      }
    });

    $(move).click(function(){
      scope.floorplanner.setMode(BP3D.Floorplanner.floorplannerModes.MOVE);
    });

    $(draw).click(function(){
      scope.floorplanner.setMode(BP3D.Floorplanner.floorplannerModes.DRAW);
    });

    $(remove).click(function(){
      scope.floorplanner.setMode(BP3D.Floorplanner.floorplannerModes.DELETE);
    });
  }

  this.updateFloorplanView = function() {
    scope.floorplanner.reset();
  }

  this.handleWindowResize = function() {
    $(canvasWrapper).height(window.innerHeight - $(canvasWrapper).offset().top);
    scope.floorplanner.resizeView();
  };

  init();
}; 

var mainControls = function(blueprint3d) {
  var blueprint3d = blueprint3d;

  // Stored state for the CAD import modal.
  // cadEntities holds the normalized entity array (from DXF or DWG) that the
  // shared CADImporter pipeline consumes.
  var cadFileName = null;
  var cadEntities = null;
  var cadHeader = null;

  function newDesign() {
    blueprint3d.model.loadSerialized('{"floorplan":{"corners":{"f90da5e3-9e0e-eba7-173d-eb0b071e838e":{"x":204.85099999999989,"y":289.052},"da026c08-d76a-a944-8e7b-096b752da9ed":{"x":672.2109999999999,"y":289.052},"4e3d65cb-54c0-0681-28bf-bddcc7bdb571":{"x":672.2109999999999,"y":-178.308},"71d4f128-ae80-3d58-9bd2-711c6ce6cdf2":{"x":204.85099999999989,"y":-178.308}},"walls":[{"corner1":"71d4f128-ae80-3d58-9bd2-711c6ce6cdf2","corner2":"f90da5e3-9e0e-eba7-173d-eb0b071e838e","frontTexture":{"url":"rooms/textures/wallmap.png","stretch":true,"scale":0},"backTexture":{"url":"rooms/textures/wallmap.png","stretch":true,"scale":0}},{"corner1":"f90da5e3-9e0e-eba7-173d-eb0b071e838e","corner2":"da026c08-d76a-a944-8e7b-096b752da9ed","frontTexture":{"url":"rooms/textures/wallmap.png","stretch":true,"scale":0},"backTexture":{"url":"rooms/textures/wallmap.png","stretch":true,"scale":0}},{"corner1":"da026c08-d76a-a944-8e7b-096b752da9ed","corner2":"4e3d65cb-54c0-0681-28bf-bddcc7bdb571","frontTexture":{"url":"rooms/textures/wallmap.png","stretch":true,"scale":0},"backTexture":{"url":"rooms/textures/wallmap.png","stretch":true,"scale":0}},{"corner1":"4e3d65cb-54c0-0681-28bf-bddcc7bdb571","corner2":"71d4f128-ae80-3d58-9bd2-711c6ce6cdf2","frontTexture":{"url":"rooms/textures/wallmap.png","stretch":true,"scale":0},"backTexture":{"url":"rooms/textures/wallmap.png","stretch":true,"scale":0}}],"wallTextures":[],"floorTextures":{},"newFloorTextures":{}},"items":[]}');
  }

  function loadDesign() {
    files = $("#loadFile").get(0).files;
    var reader  = new FileReader();
    reader.onload = function(event) {
        var data = event.target.result;
        blueprint3d.model.loadSerialized(data);
    }
    reader.readAsText(files[0]);
  }

  function saveDesign() {
    var data = blueprint3d.model.exportSerialized();
    var a = window.document.createElement('a');
    var blob = new Blob([data], {type : 'text'});
    a.href = window.URL.createObjectURL(blob);
    a.download = 'design.blueprint3d';
    document.body.appendChild(a)
    a.click();
    document.body.removeChild(a)
  }
  
  function exportToAR() {
    console.log('Export to AR clicked');
    
    // Save design to localStorage for the AR view to read
    var designData = blueprint3d.model.exportSerialized();
    localStorage.setItem('ar_room_design', designData);
    console.log('Design saved to localStorage');
    
    // Parse to check items count
    var design = JSON.parse(designData);
    var itemCount = design.items ? design.items.length : 0;
    console.log('Items in design:', itemCount);
    
    // Same-origin through the Vite proxy — the backend that answers this is the
    // one that serves the AR pages, so the IP and ports it reports are its own.
    fetch('/api/network-info')
      .then(function(response) { return response.json(); })
      .then(function(networkInfo) {
        showARExportDialog(itemCount, designData, networkInfo);
      })
      .catch(function(e) {
        console.log('Could not get network info:', e.message);
        // Fallback with placeholder
        showARExportDialog(itemCount, designData, {
          ip: 'YOUR_IP',
          arUrl: 'https://YOUR_IP:8002/ar-mobile.html',
          localUrl: 'http://localhost:8080/ar-mobile.html'
        });
      });
  }
  
  function showARExportDialog(itemCount, designData, networkInfo) {
    var localUrl = networkInfo.localUrl || 'http://localhost:8080/ar-mobile.html';
    var mobileUrl = networkInfo.arUrl || 'https://' + networkInfo.ip + ':8002/ar-mobile.html';
    
    // Show modal with link
    var modal = document.getElementById('ar-modal');
    if (modal) {
      modal.style.display = 'block';
      modal.classList.add('in');
      document.body.classList.add('modal-open');
    }
    
    document.getElementById('ar-export-loading').style.display = 'none';
    document.getElementById('ar-export-success').style.display = 'block';
    document.getElementById('ar-url').value = mobileUrl;
    
    // Generate QR code with real mobile URL
    if (typeof ARExporter !== 'undefined' && ARExporter.generateQRCode) {
      ARExporter.generateQRCode(mobileUrl, document.getElementById('ar-qr-code'));
    }
    
    // Also try to save to server
    try {
      // The Python backend both stores the design and serves it to the phone
      // from /current-design.
      fetch('/api/designs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: designData
      }).then(function(response) {
        console.log('Design saved to server:', response.ok);
      }).catch(function(e) {
        console.log('Could not save to server (this is OK):', e.message);
      });
    } catch(e) {
      console.log('Server save failed (this is OK)');
    }
    
    alert('Design exported! Items: ' + itemCount + '\n\n' +
          '📍 On this computer:\n' + localUrl + '\n\n' +
          '📱 On mobile (same WiFi):\n' + mobileUrl + '\n\n' +
          '(Scan the QR code or copy the link)');
    
    // Open AR view in new tab
    window.open(localUrl, '_blank');
  }
  
  function closeARModal() {
    var modal = document.getElementById('ar-modal');
    if (modal) {
      modal.style.display = 'none';
      modal.classList.remove('in');
      document.body.classList.remove('modal-open');
    }
  }
  
  function downloadGLB() {
    console.log('Download design clicked');
    
    // Save design as JSON file
    var designData = blueprint3d.model.exportSerialized();
    var blob = new Blob([designData], {type : 'application/json'});
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'room-design.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    
    alert('Design downloaded as JSON!');
  }
  
  function copyARUrl() {
    var urlInput = document.getElementById('ar-url');
    urlInput.select();
    document.execCommand('copy');
    
    // Show feedback
    var btn = document.getElementById('copy-ar-url');
    btn.textContent = 'Copied!';
    setTimeout(function() {
      btn.textContent = 'Copy';
    }, 2000);
  }

  // =============================================
  // CAD Import Functions
  // =============================================

  function openCADModal() {
    $('#cad-import-modal').addClass('visible');
  }

  function closeCADModal() {
    $('#cad-import-modal').removeClass('visible');
    cadEntities = null;
    cadHeader = null;
    cadFileName = null;
    $('#cad-file-info').hide();
    $('#cad-summary').hide();
    $('#cad-layers-section').hide();
    $('#cad-error').hide();
    $('#cad-import-confirm').prop('disabled', true);
    $('#cad-file-input').val('');
    $('#cad-layer-filter').val('');
  }

  function handleCADFileSelect(e) {
    var file = e.target.files[0];
    if (!file) return;

    cadFileName = file.name;
    var ext = file.name.split('.').pop().toLowerCase();

    if (ext !== 'dxf' && ext !== 'dwg') {
      $('#cad-error').text('Unsupported file format ".' + ext + '". Please upload a .dxf or .dwg file.').show();
      return;
    }

    if (ext === 'dwg') {
      readDwgFile(file);
    } else {
      readDxfFile(file);
    }
  }

  // ── DXF: text read → parse → summary ──
  function readDxfFile(file) {
    var reader = new FileReader();
    reader.onload = function(event) {
      try {
        var parsed = CADImporter.parseDxf(event.target.result);
        cadEntities = parsed.entities;
        cadHeader = parsed.header;
        showCADSummary();
      } catch (err) {
        cadEntities = null;
        $('#cad-file-name').text(cadFileName);
        $('#cad-file-info').show();
        $('#cad-error').text('Error reading DXF file: ' + err.message).show();
        $('#cad-import-confirm').prop('disabled', true);
        openCADModal();
      }
    };
    reader.onerror = function() {
      $('#cad-error').text('Error reading file. Please try again.').show();
    };
    reader.readAsText(file);
  }

  // ── DWG: binary read → libredwg (WASM) → normalized entities → summary ──
  function readDwgFile(file) {
    if (typeof DWGImporter === 'undefined' || !DWGImporter.isAvailable()) {
      $('#cad-file-name').text(cadFileName);
      $('#cad-file-info').show();
      $('#cad-error').text('DWG support is unavailable (libredwg failed to load). You can convert the file to .dxf and import that instead.').show();
      $('#cad-import-confirm').prop('disabled', true);
      openCADModal();
      return;
    }

    var reader = new FileReader();
    reader.onload = function(event) {
      // Surface the modal immediately with a loading state — wasm parse is async.
      $('#cad-file-name').text(cadFileName + ' (decoding DWG…)');
      $('#cad-file-info').show();
      $('#cad-error').hide();
      $('#cad-summary').hide();
      $('#cad-layers-section').hide();
      $('#cad-import-confirm').prop('disabled', true);
      openCADModal();

      DWGImporter.parse(event.target.result).then(function(parsed) {
        cadEntities = parsed.entities;
        cadHeader = parsed.header;
        showCADSummary();
      }).catch(function(err) {
        cadEntities = null;
        $('#cad-file-name').text(cadFileName);
        $('#cad-error').text('Error reading DWG file: ' + err.message).show();
        $('#cad-import-confirm').prop('disabled', true);
      });
    };
    reader.onerror = function() {
      $('#cad-error').text('Error reading file. Please try again.').show();
    };
    reader.readAsArrayBuffer(file);
  }

  // ── Render the entity summary, layers, and unit auto-detect, then enable import ──
  function showCADSummary() {
    $('#cad-file-name').text(cadFileName);
    $('#cad-file-info').show();
    $('#cad-error').hide();

    try {
      var summary = CADImporter.getEntitiesSummary(cadEntities);

      $('#cad-total-entities').text(summary.totalEntities);

      var typesList = [];
      for (var type in summary.entityTypes) {
        typesList.push(type + ' (' + summary.entityTypes[type] + ')');
      }
      $('#cad-entity-types').text(typesList.join(', '));
      $('#cad-summary').show();

      // Auto-detect source units from the header ($INSUNITS / INSUNITS).
      var detected = CADImporter.detectUnit(cadHeader);
      if (detected) {
        $('#cad-unit-select').val(detected);
      }

      // Auto-fill the layer filter with detected wall layers (e.g. A-WALL).
      var wallLayers = CADImporter.detectWallLayers(cadEntities);
      if (wallLayers.length > 0 && !$('#cad-layer-filter').val()) {
        $('#cad-layer-filter').val(wallLayers.join(', '));
      }

      // Show layers
      if (summary.layers.length > 0) {
        var layersHtml = '';
        summary.layers.forEach(function(layer) {
          layersHtml += '<div class="cad-layer-item">';
          layersHtml += '<label>';
          layersHtml += '<strong>' + escapeHtml(layer.name) + '</strong>';
          layersHtml += ' <span class="badge">' + layer.entityCount + ' entities</span>';
          layersHtml += '<br><small class="text-muted">' + escapeHtml(layer.entityTypes) + '</small>';
          layersHtml += '</label>';
          layersHtml += '</div>';
        });
        $('#cad-layers-list').html(layersHtml);
        $('#cad-layers-section').show();
      }

      $('#cad-import-confirm').prop('disabled', false);
    } catch (err) {
      $('#cad-error').text('Error reading CAD file: ' + err.message).show();
      $('#cad-import-confirm').prop('disabled', true);
    }

    openCADModal();
  }

  function executeCADImport() {
    if (!cadEntities) {
      $('#cad-error').text('No file loaded. Please select a DXF or DWG file.').show();
      return;
    }

    var sourceUnit = $('#cad-unit-select').val();
    var layerFilter = $('#cad-layer-filter').val();
    var collapseWalls = $('#cad-collapse-walls').is(':checked');

    try {
      // Convert the parsed entities (DXF or DWG) to Blueprint3D JSON
      var blueprintJson = CADImporter.entitiesToBlueprint(cadEntities, sourceUnit, layerFilter, { collapseWalls: collapseWalls });
      
      // Count what we got
      var cornerCount = Object.keys(blueprintJson.floorplan.corners).length;
      var wallCount = blueprintJson.floorplan.walls.length;

      if (cornerCount < 2 || wallCount < 1) {
        $('#cad-error').text('The import produced too few walls (' + wallCount + ' walls, ' + cornerCount + ' corners). Try different settings.').show();
        return;
      }

      // Load into blueprint3d — this triggers 2D → 3D propagation automatically
      var jsonString = JSON.stringify(blueprintJson);
      blueprint3d.model.loadSerialized(jsonString);

      // Close modal and show success
      closeCADModal();

      alert('CAD file imported successfully!\n\n' +
            'Corners: ' + cornerCount + '\n' +
            'Walls: ' + wallCount + '\n\n' +
            'The floorplan is now loaded in the 2D editor. ' +
            'Click "Done" to see it in 3D.');

    } catch (err) {
      $('#cad-error').text('Import failed: ' + err.message).show();
    }
  }

  function escapeHtml(text) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(text));
    return div.innerHTML;
  }

  function initCADImport() {
    // Open file dialog when import button is clicked
    $('#import-cad-btn').click(function(e) {
      e.preventDefault();
      $('#cad-file-input').click();
    });

    // Handle file selection
    $('#cad-file-input').change(handleCADFileSelect);

    // Modal controls
    $('#cad-import-cancel, .cad-modal-close, .cad-modal-backdrop').click(function(e) {
      if (e.target === this) {
        closeCADModal();
      }
    });

    // Import button
    $('#cad-import-confirm').click(executeCADImport);
  }

  function init() {
    $("#new").click(newDesign);
    $("#loadFile").change(loadDesign);
    $("#saveFile").click(saveDesign);
    
    // AR Export buttons (both in header and sidebar)
    $("#exportAR, #exportAR-sidebar").click(function(e) {
      e.preventDefault();
      console.log('Export AR button clicked');
      exportToAR();
    });
    $("#downloadGLB, #downloadGLB-sidebar").click(function(e) {
      e.preventDefault();
      console.log('Download GLB button clicked');
      downloadGLB();
    });
    $("#copy-ar-url").click(copyARUrl);
    
    // Modal close button
    $(".modal .close, .modal [data-dismiss='modal']").click(function(e) {
      e.preventDefault();
      closeARModal();
    });
    
    // CAD Import
    initCADImport();
    
    console.log('Main controls initialized');
  }

  init();
}

/*
 * Initialize!
 */

$(document).ready(function() {

  // main setup
  var opts = {
    floorplannerElement: 'floorplanner-canvas',
    threeElement: '#viewer',
    threeCanvasElement: 'three-canvas',
    textureDir: "models/textures/",
    widget: false
  }
  var blueprint3d = new BP3D.Blueprint3d(opts);

  // Expose globally so model-upload.js can access it
  window.blueprint3d = blueprint3d;

  var modalEffects = new ModalEffects(blueprint3d);
  var viewerFloorplanner = new ViewerFloorplanner(blueprint3d);
  var contextMenu = new ContextMenu(blueprint3d);
  var sideMenu = new SideMenu(blueprint3d, viewerFloorplanner, modalEffects);
  var textureSelector = new TextureSelector(blueprint3d, sideMenu);        
  var cameraButtons = new CameraButtons(blueprint3d);
  var transformGizmo = new TransformGizmo(blueprint3d);
  mainControls(blueprint3d);

  // This serialization format needs work
  // Load a simple rectangle room
  blueprint3d.model.loadSerialized('{"floorplan":{"corners":{"f90da5e3-9e0e-eba7-173d-eb0b071e838e":{"x":204.85099999999989,"y":289.052},"da026c08-d76a-a944-8e7b-096b752da9ed":{"x":672.2109999999999,"y":289.052},"4e3d65cb-54c0-0681-28bf-bddcc7bdb571":{"x":672.2109999999999,"y":-178.308},"71d4f128-ae80-3d58-9bd2-711c6ce6cdf2":{"x":204.85099999999989,"y":-178.308}},"walls":[{"corner1":"71d4f128-ae80-3d58-9bd2-711c6ce6cdf2","corner2":"f90da5e3-9e0e-eba7-173d-eb0b071e838e","frontTexture":{"url":"rooms/textures/wallmap.png","stretch":true,"scale":0},"backTexture":{"url":"rooms/textures/wallmap.png","stretch":true,"scale":0}},{"corner1":"f90da5e3-9e0e-eba7-173d-eb0b071e838e","corner2":"da026c08-d76a-a944-8e7b-096b752da9ed","frontTexture":{"url":"rooms/textures/wallmap.png","stretch":true,"scale":0},"backTexture":{"url":"rooms/textures/wallmap.png","stretch":true,"scale":0}},{"corner1":"da026c08-d76a-a944-8e7b-096b752da9ed","corner2":"4e3d65cb-54c0-0681-28bf-bddcc7bdb571","frontTexture":{"url":"rooms/textures/wallmap.png","stretch":true,"scale":0},"backTexture":{"url":"rooms/textures/wallmap.png","stretch":true,"scale":0}},{"corner1":"4e3d65cb-54c0-0681-28bf-bddcc7bdb571","corner2":"71d4f128-ae80-3d58-9bd2-711c6ce6cdf2","frontTexture":{"url":"rooms/textures/wallmap.png","stretch":true,"scale":0},"backTexture":{"url":"rooms/textures/wallmap.png","stretch":true,"scale":0}}],"wallTextures":[],"floorTextures":{},"newFloorTextures":{}},"items":[]}');
});
