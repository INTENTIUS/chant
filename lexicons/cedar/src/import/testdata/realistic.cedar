@id("owner-read")
@doc("Owners always read their own documents.")
permit (
  principal is App::User,
  action in [App::Action::"read", App::Action::"list"],
  resource is App::Document
)
when { resource.owner == principal };

@id("public-read")
permit (
  principal is App::User,
  action == App::Action::"read",
  resource is App::Document
)
when { resource.public == true }
when { context.mfa == true };

@id("owner-write")
permit (
  principal is App::User,
  action == App::Action::"write",
  resource is App::Document
)
when { resource.owner == principal }
unless { context.mfa == false };

@id("restrict-delete")
forbid (
  principal,
  action == App::Action::"delete",
  resource is App::Document
)
when { resource.classification == "confidential" }
unless { principal == App::User::"archivist" };
