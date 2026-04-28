/**
 * Model Upload Handler
 * 
 * Handles uploading GLTF/GLB files to the server,
 * displays upload progress, and dynamically adds
 * converted models to the items panel.
 */

$(document).ready(function () {

  // ─── Load user-uploaded models on page load ───
  loadUserModels();

  // ─── Clear All Placed Items ───
  $("#clear-all-items").click(function () {
    if (typeof blueprint3d !== 'undefined') {
      if (confirm('Remove all placed items from the 3D scene?')) {
        blueprint3d.model.scene.clearItems();
      }
    }
  });

  // ─── Open upload modal ───
  $("#upload-model-btn").click(function (e) {
    e.preventDefault();
    resetUploadForm();
    $("#upload-model-modal").modal("show");
  });

  // ─── Auto-fill name from filename ───
  $("#model-file-input").change(function () {
    var file = this.files[0];
    if (file && !$("#model-name-input").val()) {
      var name = file.name
        .replace(/\.(glb|gltf)$/i, "")
        .replace(/[-_]/g, " ")
        .replace(/\b\w/g, function (c) { return c.toUpperCase(); });
      $("#model-name-input").val(name);
    }
  });

  // ─── Submit upload ───
  $("#upload-model-submit").click(function () {
    var modelFile = $("#model-file-input")[0].files[0];
    var name = $("#model-name-input").val().trim();
    var type = $("#model-type-select").val();
    var thumbnailFile = $("#model-thumbnail-input")[0].files[0];
    var textureFile = $("#model-texture-input")[0].files[0];
    var scaleFactor = $("#model-scale-select").val();

    // Validate
    if (!modelFile) {
      showUploadError("Please select a .glb or .gltf file");
      return;
    }
    if (!name) {
      showUploadError("Please enter a display name");
      return;
    }

    var ext = modelFile.name.split(".").pop().toLowerCase();
    if (ext !== "glb" && ext !== "gltf") {
      showUploadError("Only .glb and .gltf files are supported");
      return;
    }

    // Build form data
    var formData = new FormData();
    formData.append("model", modelFile);
    formData.append("name", name);
    formData.append("type", type);
    formData.append("scaleFactor", scaleFactor);
    if (thumbnailFile) {
      formData.append("thumbnail", thumbnailFile);
    }
    if (textureFile) {
      formData.append("texture", textureFile);
    }

    // Show progress
    $("#upload-model-submit").prop("disabled", true);
    $("#upload-progress").show();
    $("#upload-success").hide();
    $("#upload-error").hide();
    $("#upload-progress-bar").css("width", "0%");
    $("#upload-progress-text").text("Uploading...");

    // Send to server
    $.ajax({
      url: "/api/upload-model",
      type: "POST",
      data: formData,
      processData: false,
      contentType: false,
      xhr: function () {
        var xhr = new XMLHttpRequest();
        xhr.upload.addEventListener("progress", function (e) {
          if (e.lengthComputable) {
            var pct = Math.round((e.loaded / e.total) * 50);
            $("#upload-progress-bar").css("width", pct + "%");
            if (pct >= 50) {
              $("#upload-progress-text").text("Converting...");
            }
          }
        });
        return xhr;
      },
      success: function (data) {
        $("#upload-progress-bar")
          .css("width", "100%")
          .removeClass("active");
        $("#upload-progress-text").text("Done!");

        setTimeout(function () {
          $("#upload-progress").hide();
          $("#upload-success").show();
          $("#upload-success-message").text(data.message);
          $("#upload-model-submit").prop("disabled", false);

          // Add the item to the UI immediately
          addUserItemToUI(data.item);
        }, 500);
      },
      error: function (xhr) {
        $("#upload-progress").hide();
        var msg = "Upload failed";
        try {
          msg = JSON.parse(xhr.responseText).error || msg;
        } catch (e) { }
        showUploadError(msg);
        $("#upload-model-submit").prop("disabled", false);
      }
    });
  });

  // ─── Helper functions ───

  function resetUploadForm() {
    $("#upload-model-form")[0].reset();
    $("#upload-progress").hide();
    $("#upload-success").hide();
    $("#upload-error").hide();
    $("#upload-model-submit").prop("disabled", false);
    $("#upload-progress-bar")
      .css("width", "0%")
      .addClass("active");
  }

  function showUploadError(msg) {
    $("#upload-error").show().find("#upload-error-message").text(msg);
  }

  /**
   * Load user-uploaded models from the server catalog
   * and add them to the items panel.
   */
  function loadUserModels() {
    $.get("/api/models")
      .done(function (models) {
        if (models && models.length > 0) {
          $("#user-models-section").show();
          models.forEach(function (item) {
            addUserItemToUI(item);
          });
        }
      })
      .fail(function () {
        // Server not running or no models - that's fine
        console.log("Could not load user models (server may not be running)");
      });
  }

  /**
   * Add a single user-uploaded item to the UI's item grid.
   * Makes it clickable to add to the 3D scene.
   */
  function addUserItemToUI(item) {
    $("#user-models-section").show();

    var wrapper = $("#user-items-wrapper");

    var html =
      '<div class="col-sm-4 user-model-item" data-model-name="' + item.name + '">' +
      '  <a class="thumbnail add-item" model-name="' + item.name +
      '" model-url="' + item.model +
      '" model-glb="' + (item.glb || '') +
      '" model-type="' + item.type + '"' +
      ' style="position:relative;">' +
      '    <img src="' + item.image + '" alt="' + item.name +
      '" onerror="this.src=\'data:image/svg+xml,' +
      encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="150" height="150"><rect width="150" height="150" fill="#ddd"/><text x="75" y="75" text-anchor="middle" dominant-baseline="middle" fill="#999" font-family="sans-serif" font-size="12">No Preview</text></svg>') +
      '\'">' +
      '    ' + item.name +
      '    <span class="badge" style="position:absolute;top:5px;right:5px;background:#d9534f;cursor:pointer;" ' +
      'onclick="event.preventDefault();event.stopPropagation();deleteUserModel(\'' +
      item.name.replace(/'/g, "\\'") + '\',this);" title="Delete">&times;</span>' +
      '  </a>' +
      '</div>';

    wrapper.append(html);

    // Rebind click handler for the new item
    // (the initItems() in example.js uses .mousedown on .add-item)
    wrapper.find('.add-item[model-name="' + item.name + '"]').mousedown(function (e) {
      // Access the global blueprint3d instance
      if (typeof blueprint3d !== 'undefined') {
        var modelUrl = $(this).attr("model-url");
        var glbUrl = $(this).attr("model-glb");
        var itemType = parseInt($(this).attr("model-type"));
        var metadata = {
          itemName: $(this).attr("model-name"),
          resizable: true,
          modelUrl: modelUrl,
          glbUrl: glbUrl || null,
          itemType: itemType
        };
        blueprint3d.model.scene.addItem(itemType, modelUrl, metadata);
      }
    });
  }
});

/**
 * Delete a user-uploaded model.
 * Global function so onclick in HTML can call it.
 */
function deleteUserModel(name, element) {
  if (!confirm('Delete "' + name + '"? This cannot be undone.')) return;

  $.ajax({
    url: "/api/models/" + encodeURIComponent(name),
    type: "DELETE",
    success: function () {
      // Remove from UI
      $(element).closest(".user-model-item").fadeOut(300, function () {
        $(this).remove();
        // Hide section if empty
        if ($("#user-items-wrapper").children().length === 0) {
          $("#user-models-section").hide();
        }
      });
    },
    error: function () {
      alert("Failed to delete model");
    }
  });
}
