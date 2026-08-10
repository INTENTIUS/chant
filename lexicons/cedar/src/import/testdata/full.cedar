@id("full-grant")
@doc("Everything the authoring model can carry, in one policy.")
@owner("platform")
@ticket("SEC-12")
permit (
  principal is App::User in App::Group::"engineering",
  action in [App::Action::"read", App::Action::"write", App::Action::"list"],
  resource is App::Document in App::Folder::"handbook"
)
when { resource.owner == principal && context.mfa == true }
when { principal.department == "eng" }
unless { resource.classification == "secret" }
unless { context.ip.isInRange(ip("10.0.0.0/8")) };

@id("deny-anonymous")
forbid (
  principal,
  action,
  resource
);

@id("quoted-note")
@note("say \"hi\" \\ done")
permit (
  principal == App::ServiceAccount::"ci",
  action in [App::Action::"create", App::Action::"approve"],
  resource
)
when { context.note == "a } b { c" };

@id("share-with-slots")
permit (
  principal == ?principal,
  action == App::Action::"share",
  resource in ?resource
);
