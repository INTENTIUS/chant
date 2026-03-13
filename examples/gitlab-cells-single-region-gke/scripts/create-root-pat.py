#!/usr/bin/env python3
"""
Writes /tmp/e2e_pat.rb — a Ruby snippet that creates a root PAT.
Run this inside the GitLab toolbox pod, then:
  gitlab-rails runner /tmp/e2e_pat.rb

Using a Python file avoids bash history-expansion of '!' in Ruby method names
when the command is passed through kubectl exec as a shell argument.
"""
import sys

name = sys.argv[1] if len(sys.argv) > 1 else "e2e"

ruby = (
    'user = User.find_by_username("root")\n'
    'pat = PersonalAccessToken.where(user: user, name: "' + name + '").first\n'
    'pat.update_column(:revoked, true) if pat\n'
    'pat = PersonalAccessToken.create(\n'
    '  user: user, name: "' + name + '",\n'
    '  scopes: ["api", "read_repository", "write_repository"],\n'
    '  expires_at: Date.today + 7\n'
    ')\n'
    'puts pat.token\n'
)

with open("/tmp/e2e_pat.rb", "w") as f:
    f.write(ruby)
