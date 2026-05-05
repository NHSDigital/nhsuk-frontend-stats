require 'octokit'
require 'uri'
require 'json'
require 'open-uri'
require 'base64'

client = Octokit::Client.new(:access_token => ENV.fetch('GITHUB_TOKEN'))

data = JSON.parse(File.read("data.json"))

data["services"].each do |service|

  repo = service["github"].gsub("https://github.com/", "")

  package_path = service["packageLocation"].to_s + "package.json"

  begin
    package_json = JSON.parse(Base64.decode64(client.contents(repo, path: package_path).content))


    if package_json["dependencies"] && package_json["dependencies"]["nhsuk-frontend"]
      service["nhsukFrontendVersion"] = package_json["dependencies"]["nhsuk-frontend"]
    end

    if package_json["dependencies"] && package_json["dependencies"]["nhsuk-react-components"]
      service["nhsukReactComponentsVersion"] = package_json["dependencies"]["nhsuk-react-components"]
    end

  rescue Octokit::InvalidRepository
  rescue Octokit::NotFound
  rescue Octokit::SAMLProtected
  end
end

# Update data file
File.open("data.json", 'w') do |file|
  file.write(JSON.pretty_generate(data))
  file.write "\n"
end


data["services"].sort! do |a, b|
  version_a = a["nhsukFrontendVersion"].to_s.gsub(/[\^\~]/, "")
  version_b = b["nhsukFrontendVersion"].to_s.gsub(/[\^\~]/, "")

  if version_a < version_b
    1
  elsif version_a > version_b
    -1
  else
    a["name"] <=> b["name"]
  end
end

# Update README.md
File.open("README.md", 'w') do |file|

  file.write "The following table shows the current version of [NHSUK Frontend](https://github.com/nhsuk/nhsuk-frontend) used by different services.\n\n"

  file.write "| Service | Frontend version |\n"
  file.write "| :------ | -------------------: |\n"

  data["services"].each do |service|

    name = service["name"].to_s
    url = service["github"].to_s
    frontend_version = service["nhsukFrontendVersion"].to_s

    file.write "| [#{name}](#{url}) | #{frontend_version} |\n"
  end

end
